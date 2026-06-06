// Только нужные подмножества (latin + cyrillic) и веса — чтобы не тянуть лишнее.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/cyrillic-400.css";
import "@fontsource/inter/cyrillic-500.css";
import "@fontsource/inter/cyrillic-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/cyrillic-400.css";
import "@fontsource/jetbrains-mono/cyrillic-500.css";
import "./styles.css";

import type { VideoInfo, TranscriptSegment, ExportFormat, Settings, TranscriptView } from "./types";
import * as api from "./api";
import { loadSettings, saveSettings, ACCENTS } from "./store";
import { toast } from "./toast";
import {
  fmtTimecode, fmtDuration, fmtViews, fmtPublished,
  escapeHtml, buildExport, buildParagraphs, safeFilename,
} from "./format";

/* ─── Состояние ─── */
let settings: Settings = loadSettings();
let screen: "welcome" | "loading" | "result" | "error" = "welcome";
let url = "";
let urlError = "";
let info: VideoInfo | null = null;
let activeFormat: ExportFormat = settings.exportFormat;
let view: TranscriptView = settings.transcriptView;
let analyzing = false;

let searchOpen = false;
let query = "";
let matchCount = 0; // число совпадений поиска (<mark> в текущем теле)
let markSeq = 0; // счётчик при построении тела — нумерует <mark>
let cur = 0; // индекс текущего совпадения

/* ─── DOM ─── */
const content = document.getElementById("content")!;
const settingsRoot = document.getElementById("settings-root")!;
const wordmarkSep = document.getElementById("wordmark-sep")!;
const wordmarkVideo = document.getElementById("wordmark-video")!;

/* ─── Иконка ─── */
function icon(name: string, size = 18): string {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24"><use href="#i-${name}" /></svg>`;
}
const spinnerSvg = (accent = false) =>
  `<svg class="spinner${accent ? " on-accent" : ""}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke-width="1.8"/><path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke-width="1.8" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.7s" repeatCount="indefinite"/></path></svg>`;

/** Открыть ссылку и показать тост при ошибке (чтобы клик никогда не «молчал»). */
function openLink(u: string): void {
  api.openExternal(u).catch(() => toast("Не удалось открыть ссылку", "error"));
}

/* ─── Внешний вид (тема/акцент/плотность) ─── */
function resolvedTheme(): "dark" | "light" {
  if (settings.theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return settings.theme;
}
function applyAppearance(): void {
  const root = document.documentElement;
  document.body.dataset.theme = resolvedTheme();
  document.body.dataset.density = settings.density;
  const acc = ACCENTS[settings.accent] ?? ACCENTS["#0A84FF"];
  root.style.setProperty("--accent", settings.accent);
  root.style.setProperty("--accent-hover", acc.hover);
  root.style.setProperty("--accent-active", acc.active);
  root.style.setProperty("--accent-subtle", acc.subtle);
  root.style.setProperty("--focus-ring", acc.ring);
}

/* ─── Валидация URL ─── */
const YT_RE = /(?:youtube\.com\/(?:watch\?[^ ]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;
const looksLikeYouTube = (u: string) => YT_RE.test(u.trim());

/* ============================================================
   Поток анализа
   ============================================================ */
async function analyze(): Promise<void> {
  const field = document.getElementById("url-input") as HTMLInputElement | null;
  if (field) url = field.value.trim();
  urlError = "";
  if (!url) return;
  if (!looksLikeYouTube(url)) {
    urlError = "Не похоже на ссылку YouTube";
    render();
    return;
  }

  analyzing = true;
  screen = "loading";
  render();

  try {
    info = await api.fetchVideo(url, settings.apiKey || undefined);
    query = ""; matchCount = 0; cur = 0; searchOpen = false;
    activeFormat = settings.exportFormat;
    view = settings.transcriptView;
    screen = "result";
  } catch (e) {
    info = null;
    (window as any).__lastError = String(e);
    screen = "error";
  } finally {
    analyzing = false;
    render();
  }
}

function reset(): void {
  screen = "welcome"; url = ""; urlError = ""; info = null; searchOpen = false; query = "";
  render();
}

/* ============================================================
   Рендер
   ============================================================ */
function render(): void {
  // заголовок-тулбар: имя видео
  if (screen === "result" && info) {
    wordmarkSep.hidden = false;
    wordmarkVideo.hidden = false;
    wordmarkVideo.textContent = `«${info.title}»`;
  } else {
    wordmarkSep.hidden = true;
    wordmarkVideo.hidden = true;
  }

  content.classList.toggle("no-timecodes", !settings.showTimecodes);
  content.classList.toggle("is-entering", screen !== "welcome");

  if (screen === "welcome") content.innerHTML = welcomeHtml();
  else if (screen === "loading") content.innerHTML = loadingHtml();
  else if (screen === "error") content.innerHTML = errorHtml((window as any).__lastError || "");
  else if (screen === "result" && info) content.innerHTML = resultHtml(info);

  wireScreen();
}

/* ─── URL-поле ─── */
function urlFieldHtml(compact: boolean): string {
  const trail = compact
    ? `<button class="btn primary sm" id="btn-analyze">${analyzing ? spinnerSvg(true) : ""}<span>${analyzing ? "Анализ…" : "Анализ"}</span></button>`
    : `<button class="enter-key" id="btn-analyze" aria-label="Анализировать" ${url ? "" : "disabled"}>${icon("enter", 16)}</button>`;
  return `
    <div class="url-field${compact ? " compact" : ""}${urlError ? " error" : ""}">
      <span class="lead">${icon("link", 18)}</span>
      <input id="url-input" type="text" spellcheck="false" placeholder="Вставьте ссылку на YouTube-видео" value="${escapeHtml(url)}" ${analyzing ? "disabled" : ""} />
      <div class="trail">${trail}</div>
    </div>
    ${!compact && urlError ? `<div class="field-error">${icon("warning", 14)}${escapeHtml(urlError)}</div>` : ""}`;
}

function welcomeHtml(): string {
  return `
    <div class="welcome">
      <div class="glyph">${icon("play", 30)}</div>
      <h1>Вставьте ссылку на видео</h1>
      <p class="sub">Получите транскрипт, превью и дату публикации — быстро и без лишнего.</p>
      <div class="field-wrap">${urlFieldHtml(false)}</div>
    </div>`;
}

function loadingHtml(): string {
  const rows = [92, 70, 84, 58, 76, 64, 88, 72]
    .map((w) => `<div class="seg-row"><div class="sk sk-line" style="width:40px;height:13px"></div><div class="sk sk-line" style="width:${w}%;height:13px"></div></div>`)
    .join("");
  return `
    <div class="sticky-bar">${urlFieldHtml(true)}</div>
    <div class="pad result-col rise">
      <div class="hero">
        <div class="preview-card">
          <div class="sk sk-thumb" style="border-radius:0"></div>
          <div style="display:flex;gap:8px;padding:10px"><div class="sk" style="height:30px;width:110px;border-radius:8px"></div></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:14px;padding-top:4px">
          <div class="sk sk-line" style="height:22px;width:90%"></div>
          <div class="sk sk-line" style="height:22px;width:55%"></div>
          <div style="height:8px"></div>
          <div class="sk sk-line" style="width:40%"></div>
          <div class="sk sk-line" style="width:60%"></div>
          <div class="sk sk-line" style="width:50%"></div>
        </div>
      </div>
      <div class="transcript">
        <div class="sk sk-line" style="height:16px;width:120px;margin-bottom:14px"></div>
        <div class="tr-list" style="pointer-events:none">${rows}</div>
      </div>
    </div>`;
}

function errorHtml(raw: string): string {
  const msg = raw.toLowerCase();
  let title = "Не удалось получить данные";
  let desc = "Видео может быть приватным, удалённым или требовать возрастного подтверждения. Проверьте ссылку и попробуйте ещё раз.";
  if (msg.includes("network") || msg.includes("connect") || msg.includes("dns") || msg.includes("timeout") || msg.includes("отправ")) {
    title = "Нет соединения";
    desc = "Проверьте подключение к интернету и попробуйте снова.";
  } else if (msg.includes("not found") || msg.includes("unavailable") || msg.includes("404")) {
    title = "Видео не найдено";
    desc = "Похоже, ролик удалён или ссылка неверна.";
  } else if (msg.includes("age") || msg.includes("login") || msg.includes("sign in") || msg.includes("private") || msg.includes("недоступ")) {
    title = "Видео недоступно";
    desc = "Требуется вход или возрастное подтверждение — такие ролики получить нельзя.";
  }
  return `
    <div class="sticky-bar">${urlFieldHtml(true)}</div>
    <div class="error-state rise">
      <div class="ic-wrap">${icon("warning", 28)}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(desc)}</p>
      <button class="btn secondary" id="btn-retry">${icon("retry", 16)}Повторить</button>
    </div>`;
}

/* ─── Result ─── */
function pickThumb(v: VideoInfo) {
  for (const lbl of ["maxres", "sd", "hq", "mq", "default"]) {
    const t = v.thumbnails.find((x) => x.label === lbl);
    if (t) return t;
  }
  return v.thumbnails[0] ?? null;
}

function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function resultHtml(v: VideoInfo): string {
  const pub = fmtPublished(v);
  const dur = fmtDuration(v.durationSeconds);
  const views = fmtViews(v.viewCount);
  const thumb = pickThumb(v);
  const hue = hueFromString(v.author || v.id);
  const hasDesc = !!(v.description && v.description.trim());

  const dateLine = pub.date
    ? `<div class="meta-row date" data-copy="${escapeHtml(pub.date + (pub.time ? ", " + pub.time : ""))}">
         <span class="mi">${icon("calendar", 16)}</span>
         <span class="val">${escapeHtml(pub.date)}${pub.time ? `, ${escapeHtml(pub.time)}` : ""}</span>
       </div>`
    : "";
  const timeNote = pub.date && !pub.time && !settings.apiKey
    ? `<div class="meta-note">Только дата. Точное время — ключом YouTube Data API в настройках.</div>`
    : "";

  const statBits: string[] = [];
  if (dur) statBits.push(`<span class="mi">${icon("clock", 16)}</span><span class="val">${escapeHtml(dur)}</span>`);
  if (dur && views) statBits.push(`<span class="split">·</span>`);
  if (views) statBits.push(`<span class="mi">${icon("eye", 16)}</span><span class="val">${escapeHtml(views)}</span>`);
  const statRow = statBits.length ? `<div class="meta-row" data-copy="${escapeHtml([dur, views].filter(Boolean).join(" · "))}">${statBits.join("")}</div>` : "";

  return `
    <div class="sticky-bar">${urlFieldHtml(true)}</div>
    <div class="pad result-col">
      <div class="hero rise">
        <div class="preview-card">
          <div class="thumb" id="thumb" title="Открыть на YouTube">
            ${thumb ? `<img id="thumb-img" alt="" referrerpolicy="no-referrer" />` : ""}
            <div class="grad"></div>
            <div class="thumb-cta"><span class="chip">${icon("external", 16)}Открыть на YouTube</span></div>
            ${dur ? `<span class="dur-badge">${escapeHtml(dur)}</span>` : ""}
          </div>
          <div class="preview-actions">
            <span class="split-btn">
              <button class="btn primary sm main" id="dl-main">${icon("download", 15)}Скачать</button>
              <button class="btn primary sm chev" id="dl-chev" aria-label="Выбрать разрешение">${icon("chevron", 15)}</button>
            </span>
          </div>
        </div>
        <div class="meta">
          <div class="vtitle">${escapeHtml(v.title)}</div>
          <div class="meta-rows">
            ${v.author ? `<div class="meta-row" data-copy="${escapeHtml(v.author)}"><span class="ch-dot" style="background:oklch(0.62 0.16 ${hue})"></span><span class="val">${escapeHtml(v.author)}</span></div>` : ""}
            ${dateLine}
            ${statRow}
          </div>
          ${timeNote}
          <div class="meta-actions">
            <button class="btn ghost sm" id="btn-copy-title" title="Копировать название">${icon("copy", 15)}Название</button>
            <button class="btn ghost sm" id="btn-copy-desc" title="${hasDesc ? "Копировать описание" : "У видео нет описания"}"${hasDesc ? "" : " disabled"}>${icon("copy", 15)}Описание</button>
          </div>
        </div>
      </div>
      ${transcriptHtml(v)}
    </div>`;
}

/* ─── Transcript ─── */
function pluralSeg(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "сегмент";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "сегмента";
  return "сегментов";
}

function transcriptHtml(v: VideoInfo): string {
  const t = v.transcript;
  const tracks = t.availableTracks ?? [];
  const langBtn = t.langName
    ? (tracks.length > 1
        ? `<button class="lang" id="lang-btn">${escapeHtml(t.langName)}${t.isGenerated ? " · авто" : ""}${icon("chevron", 13)}</button>`
        : `<span class="lang static">${escapeHtml(t.langName)}${t.isGenerated ? " · авто" : ""}</span>`)
    : "";

  if (!t.available || t.segments.length === 0) {
    return `
      <div class="transcript rise" style="animation-delay:80ms">
        <div class="tr-head"><h2>Транскрипт</h2>${langBtn}<span class="spacer"></span></div>
        <div class="tr-empty">
          <span class="ei">${icon("doc", 30)}</span>
          <h3>У этого видео нет субтитров</h3>
          <p>Автор не добавил субтитры, и автоматических тоже нет. Превью и данные о видео всё равно доступны выше.</p>
        </div>
      </div>`;
  }

  const fmts: ExportFormat[] = ["txt", "srt", "vtt"];
  return `
    <div class="transcript rise" style="animation-delay:80ms">
      <div class="tr-head">
        <h2>Транскрипт</h2>
        <span class="count">${t.segments.length} ${pluralSeg(t.segments.length)}</span>
        ${langBtn}
        <span class="spacer"></span>
        <div class="tr-tools">
          <div class="seg view-seg" id="view-seg">
            <span class="pill" id="view-pill"></span>
            <button data-view="flow" class="${view === "flow" ? "active" : ""}" aria-label="Сплошной текст" title="Сплошной текст">${icon("doc", 15)}</button>
            <button data-view="timecoded" class="${view === "timecoded" ? "active" : ""}" aria-label="С таймкодами" title="С таймкодами">${icon("clock", 15)}</button>
          </div>
          <div class="search-box${searchOpen ? " open" : ""}" id="search-box">
            ${icon("search", 14)}
            <input id="search-input" type="text" placeholder="Поиск в тексте…" spellcheck="false" value="${escapeHtml(query)}" />
            <span class="scount" id="scount"></span>
            <span class="snav"><button id="snav-prev" aria-label="Назад">${icon("chevUp", 14)}</button><button id="snav-next" aria-label="Вперёд">${icon("chevron", 14)}</button></span>
          </div>
          <button class="icon-btn" id="btn-search" aria-label="Поиск (Ctrl/⌘F)">${icon("search", 18)}</button>
          <div class="seg" id="seg">
            <span class="pill" id="seg-pill"></span>
            ${fmts.map((f) => `<button data-fmt="${f}" class="${f === activeFormat ? "active" : ""}">${f.toUpperCase()}</button>`).join("")}
          </div>
          <button class="icon-btn" id="btn-copy-all" aria-label="Копировать всё">${icon("copy", 18)}</button>
        </div>
      </div>
      <div class="tr-list ${view === "flow" ? "is-flow" : "is-tc"}" id="tr-list">${renderTranscriptBody(v)}</div>
    </div>`;
}

/** Построить тело транскрипта по текущему виду; попутно посчитать совпадения поиска. */
function renderTranscriptBody(v: VideoInfo): string {
  markSeq = 0;
  const segs = v.transcript.segments;
  const html = view === "flow" ? flowHtml(v, segs) : segListHtml(segs);
  matchCount = markSeq;
  if (cur >= matchCount) cur = 0;
  return html;
}

/** Обернуть совпадения поиска в <mark> со сквозной нумерацией (data-m). */
function highlightMarks(text: string): string {
  const q = query.trim().toLowerCase();
  if (!q) return escapeHtml(text);
  const lower = text.toLowerCase();
  let out = "", pos = 0, idx: number;
  while ((idx = lower.indexOf(q, pos)) !== -1) {
    out += escapeHtml(text.slice(pos, idx));
    out += `<mark data-m="${markSeq++}">${escapeHtml(text.slice(idx, idx + q.length))}</mark>`;
    pos = idx + q.length;
  }
  out += escapeHtml(text.slice(pos));
  return out;
}

/** Вид «сплошной текст» — склеенные абзацы (опц. с таймкодом начала абзаца). */
function flowHtml(v: VideoInfo, segments: TranscriptSegment[]): string {
  const paras = buildParagraphs(segments);
  const tc = settings.showTimecodes;
  const body = paras
    .map((p) => {
      const stamp = tc
        ? `<button class="tr-ts" data-t="${Math.floor(p.start)}" title="Открыть на этом моменте">${fmtTimecode(p.start)}</button>`
        : "";
      return `<p class="tr-para">${stamp}${highlightMarks(p.text)}</p>`;
    })
    .join("");
  return `<div class="tr-flow">${body}</div>`;
}

/** Вид «по сегментам» — таймкод + короткая строка. */
function segListHtml(segments: TranscriptSegment[]): string {
  return segments
    .map((s, i) =>
      `<div class="seg-row" data-i="${i}">
        <span class="tc">${fmtTimecode(s.start)}</span>
        <span class="tx">${highlightMarks(s.text)}</span>
      </div>`)
    .join("");
}

/* ============================================================
   Wiring
   ============================================================ */
function wireScreen(): void {
  const inputEl = document.getElementById("url-input") as HTMLInputElement | null;
  if (inputEl) {
    inputEl.addEventListener("input", () => { url = inputEl.value; if (urlError) { urlError = ""; document.querySelector(".url-field")?.classList.remove("error"); } updateAnalyzeEnabled(); });
    inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") analyze(); });
    if (screen === "welcome") inputEl.focus();
  }
  document.getElementById("btn-analyze")?.addEventListener("click", analyze);
  document.getElementById("btn-retry")?.addEventListener("click", analyze);

  // affordance «Вставить» на welcome, если в буфере ссылка YouTube
  if (screen === "welcome") {
    api.clipboardRead().then((clip) => {
      if (!clip || url || !looksLikeYouTube(clip)) return;
      const trail = document.querySelector(".url-field .trail");
      if (!trail || document.getElementById("btn-paste")) return;
      const b = document.createElement("button");
      b.className = "btn ghost sm"; b.id = "btn-paste";
      b.innerHTML = `${icon("clipboard", 15)}Вставить`;
      b.addEventListener("click", () => {
        url = clip.trim();
        const i = document.getElementById("url-input") as HTMLInputElement | null;
        if (i) i.value = url;
        b.remove();
        analyze();
      });
      trail.prepend(b);
    }).catch(() => {});
  }

  if (screen === "result" && info) wireResult(info);
}

function updateAnalyzeEnabled(): void {
  const btn = document.getElementById("btn-analyze");
  if (btn && btn.classList.contains("enter-key")) (btn as HTMLButtonElement).disabled = !url;
}

function wireResult(v: VideoInfo): void {
  // превью
  const img = document.getElementById("thumb-img") as HTMLImageElement | null;
  const thumbEl = document.getElementById("thumb");
  if (img) {
    let tried = 0;
    const fail = () => {
      if (thumbEl && !thumbEl.querySelector(".thumb-ph")) {
        const ph = document.createElement("div");
        ph.className = "thumb-ph";
        ph.innerHTML = `${icon("play", 26)}<span>превью</span>`;
        thumbEl.prepend(ph);
      }
    };
    img.addEventListener("load", () => {
      if (img.naturalWidth <= 120) { // серый плейсхолдер YouTube
        if (tried === 0) { tried = 1; img.src = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`; return; }
        fail(); return;
      }
      img.classList.add("loaded");
    });
    img.addEventListener("error", () => {
      if (tried === 0) { tried = 1; img.src = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`; }
      else fail();
    });
    img.src = (pickThumb(v)?.url) ?? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
  }
  thumbEl?.addEventListener("click", () => openLink(v.url));

  // копирование названия и описания (описание на экран не выводим — бывает очень длинным)
  document.getElementById("btn-copy-title")?.addEventListener("click", async () => {
    await api.clipboardWrite(v.title || "");
    toast("Название скопировано");
  });
  document.getElementById("btn-copy-desc")?.addEventListener("click", async () => {
    const d = (v.description || "").trim();
    if (!d) { toast("У видео нет описания", "error"); return; }
    await api.clipboardWrite(d);
    toast("Описание скопировано");
  });

  // скачивание превью
  document.getElementById("dl-main")?.addEventListener("click", () => downloadThumb(v, pickThumb(v)?.url));
  document.getElementById("dl-chev")?.addEventListener("click", (e) => openThumbMenu(e, v));

  // копирование мета-строк
  content.querySelectorAll<HTMLElement>(".meta-row[data-copy]").forEach((row) =>
    row.addEventListener("click", () => { api.clipboardWrite(row.dataset.copy || ""); toast("Скопировано"); }));

  // язык
  document.getElementById("lang-btn")?.addEventListener("click", (e) => openLangMenu(e, v));

  // транскрипт-инструменты
  if (v.transcript.available && v.transcript.segments.length) {
    positionPill(document.getElementById("seg"));
    positionPill(document.getElementById("view-seg"));

    // переключатель вида (сплошной текст / таймкоды)
    content.querySelectorAll<HTMLButtonElement>("#view-seg button[data-view]").forEach((b) =>
      b.addEventListener("click", () => {
        const nv = b.dataset.view as TranscriptView;
        if (nv === view) return;
        view = nv; settings.transcriptView = nv; saveSettings(settings);
        setSegActive("view-seg", b);
        const list = document.getElementById("tr-list");
        if (list) list.className = `tr-list ${view === "flow" ? "is-flow" : "is-tc"}`;
        updateSearch(); // перерисовать тело, пересчитать совпадения и счётчик
      }));

    // формат экспорта (клик = сохранить файл)
    content.querySelectorAll<HTMLButtonElement>("#seg button[data-fmt]").forEach((b) =>
      b.addEventListener("click", () => {
        activeFormat = b.dataset.fmt as ExportFormat;
        settings.exportFormat = activeFormat; saveSettings(settings);
        setSegActive("seg", b);
        exportTranscript(v);
      }));

    document.getElementById("btn-copy-all")?.addEventListener("click", async () => {
      const text = buildExport(v.transcript.segments, "txt", { withTimecodes: settings.showTimecodes });
      await api.clipboardWrite(text);
      toast("Транскрипт скопирован");
    });

    document.getElementById("btn-search")?.addEventListener("click", () => toggleSearch());
    const si = document.getElementById("search-input") as HTMLInputElement | null;
    if (si) {
      let deb: number | undefined;
      si.addEventListener("input", () => { window.clearTimeout(deb); deb = window.setTimeout(() => { query = si.value; cur = 0; updateSearch(); }, 110); });
      si.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); nav(e.shiftKey ? -1 : 1); }
        if (e.key === "Escape") { query = ""; si.value = ""; toggleSearch(false); }
      });
    }
    document.getElementById("snav-prev")?.addEventListener("click", () => nav(-1));
    document.getElementById("snav-next")?.addEventListener("click", () => nav(1));

    // делегированный клик по телу: таймкод-чип открывает момент, строка копирует сегмент
    document.getElementById("tr-list")?.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const ts = target.closest(".tr-ts") as HTMLElement | null;
      if (ts) {
        openLink(`https://www.youtube.com/watch?v=${v.id}&t=${ts.dataset.t || 0}s`);
        return;
      }
      if (view === "timecoded") {
        const row = target.closest(".seg-row") as HTMLElement | null;
        if (!row) return;
        const s = v.transcript.segments[+row.dataset.i!];
        if (s) { api.clipboardWrite(s.text); toast("Сегмент скопирован"); }
      }
    });
  }
}

/** Сместить «пилюлю» сегмент-контрола под активную кнопку. */
function positionPill(seg: HTMLElement | null): void {
  if (!seg) return;
  const pill = seg.querySelector(".pill") as HTMLElement | null;
  const active = seg.querySelector("button.active") as HTMLElement | null;
  if (!pill || !active) return;
  pill.style.transform = `translateX(${active.offsetLeft - 2}px)`;
  pill.style.width = `${active.offsetWidth}px`;
}

/** Пометить активной одну кнопку в сегмент-контроле и переставить пилюлю. */
function setSegActive(segId: string, btn: HTMLElement): void {
  const seg = document.getElementById(segId);
  if (!seg) return;
  seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === btn));
  positionPill(seg);
}

/* ─── Поиск ─── */
function toggleSearch(force?: boolean): void {
  searchOpen = force ?? !searchOpen;
  const box = document.getElementById("search-box");
  box?.classList.toggle("open", searchOpen);
  if (searchOpen) (document.getElementById("search-input") as HTMLInputElement | null)?.focus();
  else { query = ""; updateSearch(); }
}
function updateSearch(): void {
  if (!info) return;
  const list = document.getElementById("tr-list");
  if (list) list.innerHTML = renderTranscriptBody(info);
  const sc = document.getElementById("scount");
  if (sc) sc.textContent = query.trim() ? `${matchCount ? cur + 1 : 0}/${matchCount}` : "";
  applyActiveMark(true);
}
function nav(dir: number): void {
  if (!matchCount) return;
  cur = (cur + dir + matchCount) % matchCount;
  const sc = document.getElementById("scount");
  if (sc) sc.textContent = `${cur + 1}/${matchCount}`;
  applyActiveMark(true);
}
/** Подсветить текущее совпадение и (опц.) проскроллить к нему. */
function applyActiveMark(doScroll: boolean): void {
  const list = document.getElementById("tr-list");
  if (!list) return;
  list.querySelectorAll("mark.active").forEach((m) => m.classList.remove("active"));
  if (!matchCount) return;
  const el = list.querySelectorAll("mark")[cur] as HTMLElement | undefined;
  if (!el) return;
  el.classList.add("active");
  if (doScroll) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

/* ─── Скачивание превью ─── */
async function downloadThumb(v: VideoInfo, url?: string): Promise<void> {
  if (!url) return;
  try {
    const ok = await api.saveImageFile(url, safeFilename(v.title, v.id) + "_preview", "jpg");
    if (ok) toast("Превью сохранено");
  } catch { toast("Не удалось сохранить", "error"); }
}
function openThumbMenu(e: Event, v: VideoInfo): void {
  e.stopPropagation();
  closeMenus();
  const items = v.thumbnails
    .slice().sort((a, b) => b.width - a.width)
    .map((t) => `<button class="menu-item" data-url="${escapeHtml(t.url)}">${labelRu(t.label)}<span class="res">${t.width}×${t.height}</span></button>`)
    .join("");
  const pop = makePopover(`<div class="menu-label">Превью</div>${items}<div class="menu-sep"></div><button class="menu-item" data-url="${escapeHtml(pickThumb(v)?.url || "")}">${icon("download", 15)}Сохранить как…</button>`, e.currentTarget as HTMLElement);
  pop.querySelectorAll<HTMLButtonElement>(".menu-item").forEach((b) =>
    b.addEventListener("click", () => { const u = b.dataset.url; closeMenus(); downloadThumb(v, u); }));
}
const labelRu = (l: string) => (({ maxres: "Максимальное", sd: "Большое", hq: "Высокое", mq: "Среднее", default: "Обычное" } as Record<string, string>)[l] ?? l);

/* ─── Язык субтитров ─── */
function openLangMenu(e: Event, v: VideoInfo): void {
  e.stopPropagation();
  closeMenus();
  const items = v.transcript.availableTracks
    .map((tr) => `<button class="menu-item" data-lang="${escapeHtml(tr.langCode)}" data-gen="${tr.isGenerated}">${escapeHtml(tr.langName)}<span class="res">${tr.isGenerated ? "авто" : ""}</span></button>`)
    .join("");
  const pop = makePopover(`<div class="menu-label">Язык субтитров</div>${items}`, e.currentTarget as HTMLElement, "left");
  pop.querySelectorAll<HTMLButtonElement>(".menu-item").forEach((b) =>
    b.addEventListener("click", async () => {
      const lang = b.dataset.lang!; const gen = b.dataset.gen === "true";
      closeMenus();
      try {
        const t = await api.fetchTranscript(v.id, lang, gen);
        v.transcript = t;
        query = ""; cur = 0; searchOpen = false;
        render();
        toast("Язык переключён");
      } catch { toast("Не удалось загрузить дорожку", "error"); }
    }));
}

/* ─── Экспорт ─── */
async function exportTranscript(v: VideoInfo): Promise<void> {
  if (!v.transcript.available) { toast("Нет транскрипта", "error"); return; }
  const text = buildExport(v.transcript.segments, activeFormat, { withTimecodes: settings.showTimecodes, title: v.title });
  const filterName = { txt: "Текст", srt: "Субтитры SRT", vtt: "Субтитры VTT" }[activeFormat];
  try {
    const ok = await api.saveTextFile(text, safeFilename(v.title, v.id), activeFormat, filterName);
    if (ok) toast(`Сохранено — ${activeFormat.toUpperCase()}`);
  } catch { toast("Не удалось сохранить", "error"); }
}

/* ─── Popover helpers ─── */
function makePopover(html: string, anchor: HTMLElement, align: "left" | "right" = "right"): HTMLElement {
  const pop = document.createElement("div");
  pop.className = "pop"; pop.dataset.menu = "1"; pop.innerHTML = html;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  if (align === "right") pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;
  else pop.style.left = `${r.left}px`;
  const pr = pop.getBoundingClientRect();
  if (pr.bottom > window.innerHeight - 8) pop.style.top = `${Math.max(8, r.top - pr.height - 6)}px`;
  return pop;
}
function closeMenus(): void { document.querySelectorAll("[data-menu]").forEach((m) => m.remove()); }
document.addEventListener("mousedown", (e) => {
  const tgt = e.target as HTMLElement;
  if (!tgt.closest("[data-menu]") && !tgt.closest("#dl-chev") && !tgt.closest("#lang-btn")) closeMenus();
});

/* ============================================================
   Settings
   ============================================================ */
function openSettings(): void {
  settingsRoot.innerHTML = `
    <div class="scrim" id="scrim">
      <div class="sheet" role="dialog" aria-label="Настройки">
        <div class="sheet-head">
          <h2>Настройки</h2>
          <button class="icon-btn" id="set-close" aria-label="Закрыть">${icon("close", 18)}</button>
        </div>
        <div class="sheet-body">
          <div class="set-group">
            <div class="gl">Внешний вид</div>
            <div class="set-row"><span class="label">Тема</span>
              <select class="sel" id="set-theme">
                <option value="dark"${sel(settings.theme === "dark")}>Тёмная</option>
                <option value="light"${sel(settings.theme === "light")}>Светлая</option>
                <option value="system"${sel(settings.theme === "system")}>Системная</option>
              </select>
            </div>
          </div>
          <div class="set-group">
            <div class="gl">Транскрипт</div>
            <div class="set-row"><span class="label">Язык по умолчанию</span>
              <select class="sel" id="set-lang">
                <option value="auto"${sel(settings.defaultLang === "auto")}>Авто</option>
                <option value="ru"${sel(settings.defaultLang === "ru")}>Русский</option>
                <option value="en"${sel(settings.defaultLang === "en")}>English</option>
              </select>
            </div>
            <div class="set-row"><span class="label">Показывать таймкоды</span>
              <button class="toggle${settings.showTimecodes ? " on" : ""}" id="set-tc" role="switch" aria-checked="${settings.showTimecodes}"><span class="knob"></span></button>
            </div>
            <div class="set-row"><span class="label">Формат экспорта</span>
              <select class="sel" id="set-fmt">
                <option value="txt"${sel(settings.exportFormat === "txt")}>TXT</option>
                <option value="srt"${sel(settings.exportFormat === "srt")}>SRT</option>
                <option value="vtt"${sel(settings.exportFormat === "vtt")}>VTT</option>
              </select>
            </div>
          </div>
          <div class="set-group">
            <div class="gl">Точное время публикации</div>
            <div style="padding-top:6px">
              <div class="set-row" style="padding-bottom:4px"><span class="label" style="flex:none">YouTube Data API ключ</span></div>
              <div class="pw-field"><input id="set-apikey" type="password" placeholder="••••••••••••••••" value="${escapeHtml(settings.apiKey)}" /></div>
              <div class="set-note">${icon("info", 14)}<span>Обычно дата и время определяются автоматически. Ключ нужен как резерв — если YouTube отдаёт только дату.</span></div>
            </div>
          </div>
          <div class="set-group">
            <div class="gl">О программе</div>
            <div class="about" style="padding-top:4px">viTool 1.0 · <a id="set-src">открыть исходники ${icon("external", 13)}</a></div>
          </div>
        </div>
      </div>
    </div>`;

  const close = () => { settingsRoot.innerHTML = ""; };
  document.getElementById("scrim")!.addEventListener("mousedown", (e) => { if (e.target === e.currentTarget) close(); });
  document.getElementById("set-close")!.addEventListener("click", close);

  document.getElementById("set-theme")!.addEventListener("change", (e) => { settings.theme = (e.target as HTMLSelectElement).value as Settings["theme"]; persistAndApply(); });
  document.getElementById("set-lang")!.addEventListener("change", (e) => { settings.defaultLang = (e.target as HTMLSelectElement).value; saveSettings(settings); });
  document.getElementById("set-fmt")!.addEventListener("change", (e) => {
    settings.exportFormat = (e.target as HTMLSelectElement).value as ExportFormat;
    activeFormat = settings.exportFormat; saveSettings(settings);
    // синхронизировать сегмент-контрол экспорта на экране результата
    const seg = document.getElementById("seg");
    const btn = seg?.querySelector(`button[data-fmt="${activeFormat}"]`) as HTMLElement | null;
    if (btn) setSegActive("seg", btn);
  });
  document.getElementById("set-tc")!.addEventListener("click", (e) => {
    settings.showTimecodes = !settings.showTimecodes;
    const b = e.currentTarget as HTMLElement;
    b.classList.toggle("on", settings.showTimecodes); b.setAttribute("aria-checked", String(settings.showTimecodes));
    content.classList.toggle("no-timecodes", !settings.showTimecodes);
    saveSettings(settings);
    // перерисовать тело: таймкоды-чипы в абзацах появляются/исчезают
    if (screen === "result" && info?.transcript.available) {
      const list = document.getElementById("tr-list");
      if (list) { list.innerHTML = renderTranscriptBody(info); applyActiveMark(false); }
    }
  });
  document.getElementById("set-apikey")!.addEventListener("change", (e) => { settings.apiKey = (e.target as HTMLInputElement).value.trim(); saveSettings(settings); });
  document.getElementById("set-src")!.addEventListener("click", () => openLink("https://github.com/"));
}
const sel = (on: boolean) => (on ? " selected" : "");
function persistAndApply(): void { saveSettings(settings); applyAppearance(); }

/* ============================================================
   Init
   ============================================================ */
function init(): void {
  applyAppearance();

  // система меняет тему — обновить при theme=system
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (settings.theme === "system") applyAppearance(); });

  document.getElementById("btn-settings")!.addEventListener("click", openSettings);
  const wm = document.getElementById("wordmark")!;
  wm.addEventListener("click", () => { if (screen !== "welcome") reset(); });
  wm.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && screen !== "welcome") { e.preventDefault(); reset(); } });

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") { if (settingsRoot.innerHTML) settingsRoot.innerHTML = ""; else if (searchOpen) toggleSearch(false); closeMenus(); }
    if (mod && e.key.toLowerCase() === "f" && screen === "result" && info?.transcript.available) { e.preventDefault(); toggleSearch(true); }
  });

  render();
}

document.addEventListener("DOMContentLoaded", init);
