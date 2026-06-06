use anyhow::{anyhow, bail, Context, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

use crate::models::{Thumbnail, Transcript, TranscriptSegment, TranscriptTrack, VideoInfo};

// Десктопный UA для watch-страницы.
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// UA Android-приложения — для InnerTube ANDROID и запросов субтитров.
const ANDROID_UA: &str = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";

// Публичный ключ InnerTube (используется в открытых проектах; не секрет).
const INNERTUBE_KEY: &str = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

// Клиенты InnerTube в порядке устойчивости к PoToken для субтитров (yt-dlp wiki, 2026).
const CLIENTS: &[(&str, &str)] = &[
    ("ANDROID", "20.10.38"),
    ("TVHTML5_SIMPLY_EMBEDDED_PLAYER", "2.0"),
    ("WEB_EMBEDDED_PLAYER", "1.20240101.00.00"),
];

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(UA)
            .gzip(true)
            .build()
            .expect("не удалось создать HTTP-клиент")
    })
}

/// Выбор дорожки субтитров.
enum Pick {
    Default,
    Specific { lang: String, generated: bool },
}

/// Извлечь и провалидировать 11-символьный videoId.
pub fn extract_video_id(input: &str) -> Option<String> {
    let s = input.trim();
    let re = Regex::new(r"(?:v=|/shorts/|/embed/|/live/|youtu\.be/|/v/)([A-Za-z0-9_-]{11})").ok()?;
    if let Some(c) = re.captures(s) {
        return Some(c[1].to_string());
    }
    if Regex::new(r"^[A-Za-z0-9_-]{11}$").ok()?.is_match(s) {
        return Some(s.to_string());
    }
    None
}

/// Найти первый сбалансированный JSON-объект после маркера (учёт строк/экранирования).
fn extract_json_after(html: &str, marker: &str) -> Option<Value> {
    let start = html.find(marker)?;
    let brace_start = html[start..].find('{')? + start;
    let bytes = html.as_bytes();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escape = false;
    let mut end = None;
    for i in brace_start..bytes.len() {
        let c = bytes[i];
        if in_str {
            if escape {
                escape = false;
            } else if c == b'\\' {
                escape = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else {
            match c {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(i + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    serde_json::from_str(&html[brace_start..end?]).ok()
}

/// Watch-страница → ytInitialPlayerResponse (метаданные + точная дата/время).
async fn fetch_watch_player(video_id: &str) -> Result<Value> {
    let url = format!("https://www.youtube.com/watch?v={}&hl=en&gl=US", video_id);
    let html = http()
        .get(&url)
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Cookie", "SOCS=CAI") // обход EU-интерстициала согласия
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;

    if html.contains("consent.youtube.com") && !html.contains("ytInitialPlayerResponse") {
        bail!("Страница согласия YouTube (consent wall)");
    }
    extract_json_after(&html, "ytInitialPlayerResponse")
        .ok_or_else(|| anyhow!("не найден ytInitialPlayerResponse"))
}

/// InnerTube player для заданного клиента (источник рабочих baseUrl субтитров).
async fn innertube_player(video_id: &str, name: &str, version: &str) -> Result<Value> {
    let mut client_ctx = json!({
        "clientName": name, "clientVersion": version, "hl": "en", "gl": "US"
    });
    if name == "ANDROID" {
        client_ctx["androidSdkVersion"] = json!(34);
    }
    let body = json!({
        "context": { "client": client_ctx },
        "videoId": video_id,
        "contentCheckOk": true,
        "racyCheckOk": true
    });
    let url = format!("https://www.youtube.com/youtubei/v1/player?key={}", INNERTUBE_KEY);
    let mut req = http()
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Origin", "https://www.youtube.com");
    if name == "ANDROID" {
        req = req.header("User-Agent", ANDROID_UA);
    }
    let resp = req.json(&body).send().await?.error_for_status()?;
    Ok(resp.json::<Value>().await?)
}

fn caption_tracks(pr: &Value) -> Vec<Value> {
    pr["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn track_meta(t: &Value) -> TranscriptTrack {
    let lang_code = t["languageCode"].as_str().unwrap_or("").to_string();
    let lang_name = t["name"]["simpleText"]
        .as_str()
        .or_else(|| t["name"]["runs"][0]["text"].as_str())
        .unwrap_or(&lang_code)
        .to_string();
    let is_generated = t["kind"].as_str() == Some("asr");
    TranscriptTrack { lang_code, lang_name, is_generated }
}

fn select_track(tracks: &[Value], pick: &Pick) -> Option<usize> {
    match pick {
        Pick::Specific { lang, generated } => tracks.iter().position(|t| {
            t["languageCode"].as_str() == Some(lang.as_str())
                && (t["kind"].as_str() == Some("asr")) == *generated
        }),
        Pick::Default => {
            // приоритет: авто (asr) — полный транскрипт речи; иначе первая ручная дорожка
            let mut manual = None;
            for (i, t) in tracks.iter().enumerate() {
                if t["kind"].as_str() == Some("asr") {
                    return Some(i);
                } else if manual.is_none() {
                    manual = Some(i);
                }
            }
            manual
        }
    }
}

fn strip_fmt(url: &str) -> String {
    Regex::new(r"&fmt=\w+").unwrap().replace_all(url, "").to_string()
}

/// HTML-деэкранирование (для XML-фолбэка субтитров).
fn html_unescape(s: &str) -> String {
    let re = Regex::new(r"&#(\d+);").unwrap();
    let s = re.replace_all(s, |c: &regex::Captures| {
        c[1].parse::<u32>().ok().and_then(char::from_u32).map(|ch| ch.to_string()).unwrap_or_default()
    });
    s.replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn parse_json3(v: &Value) -> Vec<TranscriptSegment> {
    let mut segs = Vec::new();
    if let Some(events) = v["events"].as_array() {
        for ev in events {
            let Some(parts) = ev["segs"].as_array() else { continue }; // пропуск маркеров без segs
            let start = ev["tStartMs"].as_f64().unwrap_or(0.0) / 1000.0;
            let dur = ev["dDurationMs"].as_f64().unwrap_or(0.0) / 1000.0;
            let text: String = parts.iter().filter_map(|s| s["utf8"].as_str()).collect();
            let text = text.replace('\n', " ").trim().to_string();
            if !text.is_empty() {
                segs.push(TranscriptSegment { start, dur, text });
            }
        }
    }
    segs
}

fn parse_xml(xml: &str) -> Vec<TranscriptSegment> {
    // Атрибуты start/dur извлекаются по имени — порядок и наличие не зависят от разметки.
    let tag = Regex::new(r#"<text\b([^>]*)>([\s\S]*?)</text>"#).unwrap();
    let attr = Regex::new(r#"(\w+)="([^"]*)""#).unwrap();
    let mut segs = Vec::new();
    for c in tag.captures_iter(xml) {
        let mut start = 0.0;
        let mut dur = 0.0;
        for a in attr.captures_iter(&c[1]) {
            match &a[1] {
                "start" => start = a[2].parse().unwrap_or(0.0),
                "dur" => dur = a[2].parse().unwrap_or(0.0),
                _ => {}
            }
        }
        let text = html_unescape(&c[2]).replace('\n', " ").trim().to_string();
        if !text.is_empty() {
            segs.push(TranscriptSegment { start, dur, text });
        }
    }
    segs
}

/// Скачать дорожку субтитров: json3, при неудаче — XML (формат по умолчанию).
async fn fetch_segments(base_url: &str) -> Result<Vec<TranscriptSegment>> {
    let json_url = format!("{}&fmt=json3", strip_fmt(base_url));
    if let Ok(resp) = http()
        .get(&json_url)
        .header("User-Agent", ANDROID_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
    {
        if let Ok(v) = resp.json::<Value>().await {
            let segs = parse_json3(&v);
            if !segs.is_empty() {
                return Ok(segs);
            }
        }
    }
    // XML-фолбэк
    let xml = http()
        .get(strip_fmt(base_url))
        .header("User-Agent", ANDROID_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    Ok(parse_xml(&xml))
}

/// Попытаться получить транскрипт из конкретного player response.
async fn try_client(pr: &Value, pick: &Pick, metas: &mut Vec<TranscriptTrack>) -> Option<Transcript> {
    let tracks = caption_tracks(pr);
    if tracks.is_empty() {
        return None;
    }
    if metas.is_empty() {
        *metas = tracks.iter().map(track_meta).collect();
    }
    let i = select_track(&tracks, pick)?;
    let base = tracks[i]["baseUrl"].as_str().unwrap_or("");
    // PoToken-gated дорожка — пропускаем, пробуем другой клиент
    if base.is_empty() || base.contains("exp=xpe") {
        return None;
    }
    let segs = fetch_segments(base).await.ok()?;
    if segs.is_empty() {
        return None;
    }
    let meta = track_meta(&tracks[i]);
    Some(Transcript {
        available: true,
        lang_code: Some(meta.lang_code.clone()),
        lang_name: Some(meta.lang_name.clone()),
        is_generated: meta.is_generated,
        segments: segs,
        available_tracks: metas.clone(),
    })
}

/// Получить транскрипт, перебирая клиентов InnerTube (с опц. предзагруженным ANDROID).
async fn build_transcript(video_id: &str, prefetched: Option<&Value>, pick: Pick) -> Transcript {
    let mut metas: Vec<TranscriptTrack> = Vec::new();

    if let Some(pr) = prefetched {
        if let Some(t) = try_client(pr, &pick, &mut metas).await {
            return t;
        }
    }
    for &(name, version) in CLIENTS {
        // ANDROID уже пробовали через prefetched — не дублируем запрос
        if prefetched.is_some() && name == "ANDROID" {
            continue;
        }
        if let Ok(pr) = innertube_player(video_id, name, version).await {
            if let Some(t) = try_client(&pr, &pick, &mut metas).await {
                return t;
            }
        }
    }
    Transcript::empty(metas)
}

/// Превью YouTube — предсказуемые URL по videoId.
fn build_thumbnails(video_id: &str) -> Vec<Thumbnail> {
    [
        ("maxres", "maxresdefault", 1280u32, 720u32),
        ("sd", "sddefault", 640, 480),
        ("hq", "hqdefault", 480, 360),
        ("mq", "mqdefault", 320, 180),
        ("default", "default", 120, 90),
    ]
    .iter()
    .map(|(label, file, w, h)| Thumbnail {
        url: format!("https://i.ytimg.com/vi/{}/{}.jpg", video_id, file),
        width: *w,
        height: *h,
        label: label.to_string(),
    })
    .collect()
}

/// Разобрать publishDate: вернуть (дата "YYYY-MM-DD", полный RFC3339 если есть время).
fn parse_published(raw: &str) -> (Option<String>, Option<String>) {
    let date_re = Regex::new(r"^(\d{4}-\d{2}-\d{2})").unwrap();
    // Полный таймстемп: должен начинаться с валидной даты.
    if raw.contains('T') {
        if let Some(c) = date_re.captures(raw) {
            return (Some(c[1].to_string()), Some(raw.to_string()));
        }
    }
    // Иначе — найти дату где угодно в строке.
    if let Some(c) = Regex::new(r"(\d{4}-\d{2}-\d{2})").unwrap().captures(raw) {
        return (Some(c[1].to_string()), None);
    }
    (None, None)
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

/// Главная команда: метаданные (watch) + транскрипт (ANDROID InnerTube) + опц. Data API.
pub async fn fetch_video(input: &str, api_key: Option<&str>) -> Result<VideoInfo> {
    let video_id = extract_video_id(input).ok_or_else(|| anyhow!("Не удалось распознать ссылку YouTube"))?;

    // Источник метаданных (точная дата/время) — watch-страница.
    let watch = fetch_watch_player(&video_id).await.ok();
    // Источник субтитров — ANDROID InnerTube (рабочие baseUrl).
    let android = innertube_player(&video_id, "ANDROID", "20.10.38").await.ok();

    // videoDetails: предпочесть watch, иначе android.
    let vd: Option<&Value> = watch
        .as_ref()
        .map(|w| &w["videoDetails"])
        .filter(|v| !v.is_null())
        .or_else(|| android.as_ref().map(|a| &a["videoDetails"]).filter(|v| !v.is_null()));

    let vd = match vd {
        Some(v) => v,
        None => {
            // Нет деталей ни там, ни там → выяснить причину недоступности.
            let reason = watch
                .as_ref()
                .or(android.as_ref())
                .and_then(|p| p["playabilityStatus"]["reason"].as_str())
                .unwrap_or("Видео недоступно");
            bail!("{}", reason);
        }
    };

    let title = str_field(vd, "title").unwrap_or("").to_string();
    let author = str_field(vd, "author").unwrap_or("").to_string();
    let channel_id = str_field(vd, "channelId").map(|s| s.to_string());
    let duration_seconds = str_field(vd, "lengthSeconds").and_then(|s| s.parse::<u64>().ok());
    let view_count = str_field(vd, "viewCount").and_then(|s| s.parse::<u64>().ok());
    let description = str_field(vd, "shortDescription").map(|s| s.to_string());

    // microformat (только watch) — дата/время и профиль канала.
    let mf = watch.as_ref().map(|w| &w["microformat"]["playerMicroformatRenderer"]);
    let (publish_date, publish_datetime_iso) = mf
        .and_then(|m| m["publishDate"].as_str().or_else(|| m["uploadDate"].as_str()))
        .map(parse_published)
        .unwrap_or((None, None));
    let channel_url = mf
        .and_then(|m| m["ownerProfileUrl"].as_str())
        .map(|s| s.to_string())
        .or_else(|| channel_id.as_ref().map(|id| format!("https://www.youtube.com/channel/{}", id)));

    // Транскрипт по умолчанию (ANDROID prefetched + фолбэк-клиенты).
    let transcript = build_transcript(&video_id, android.as_ref(), Pick::Default).await;

    let mut info = VideoInfo {
        id: video_id.clone(),
        url: format!("https://www.youtube.com/watch?v={}", video_id),
        title,
        author,
        channel_url,
        channel_id,
        publish_date,
        publish_datetime_iso,
        duration_seconds,
        view_count,
        description,
        thumbnails: build_thumbnails(&video_id),
        transcript,
    };

    // Data API — только как резерв, если точного времени ещё нет.
    if info.publish_datetime_iso.is_none() {
        if let Some(key) = api_key {
            if !key.is_empty() {
                let _ = enrich_with_data_api(&video_id, key, &mut info).await;
            }
        }
    }

    Ok(info)
}

/// Получить транскрипт в конкретном языке (переключение дорожки).
pub async fn fetch_transcript(video_id: &str, lang_code: &str, is_generated: bool) -> Result<Transcript> {
    Ok(build_transcript(
        video_id,
        None,
        Pick::Specific { lang: lang_code.to_string(), generated: is_generated },
    )
    .await)
}

/// Обогащение через Data API v3 (точное время). Ошибки не критичны.
async fn enrich_with_data_api(video_id: &str, api_key: &str, info: &mut VideoInfo) -> Result<()> {
    let url = format!(
        "https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id={}&key={}",
        video_id, api_key
    );
    let v: Value = http().get(&url).send().await?.error_for_status()?.json().await?;
    let item = v["items"].get(0).ok_or_else(|| anyhow!("Data API: видео не найдено"))?;

    if let Some(published) = item["snippet"]["publishedAt"].as_str() {
        let (d, dt) = parse_published(published);
        info.publish_datetime_iso = dt;
        if d.is_some() {
            info.publish_date = d;
        }
    }
    if info.view_count.is_none() {
        info.view_count = item["statistics"]["viewCount"].as_str().and_then(|s| s.parse().ok());
    }
    Ok(())
}

/// Скачать файл (превью) в указанный путь.
pub async fn download_file(url: &str, dest: &str) -> Result<()> {
    let bytes = http().get(url).send().await?.error_for_status()?.bytes().await?;
    std::fs::write(dest, &bytes).with_context(|| format!("не удалось записать {}", dest))?;
    Ok(())
}

/// Записать текстовый файл по абсолютному пути.
pub fn save_text(path: &str, contents: &str) -> Result<()> {
    std::fs::write(path, contents).with_context(|| format!("не удалось записать {}", path))?;
    Ok(())
}
