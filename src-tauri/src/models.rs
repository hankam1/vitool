use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Thumbnail {
    pub url: String,
    pub width: u32,
    pub height: u32,
    pub label: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start: f64,
    pub dur: f64,
    pub text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTrack {
    pub lang_code: String,
    pub lang_name: String,
    pub is_generated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub available: bool,
    pub lang_code: Option<String>,
    pub lang_name: Option<String>,
    pub is_generated: bool,
    pub segments: Vec<TranscriptSegment>,
    pub available_tracks: Vec<TranscriptTrack>,
}

impl Transcript {
    pub fn empty(tracks: Vec<TranscriptTrack>) -> Self {
        Transcript {
            available: false,
            lang_code: None,
            lang_name: None,
            is_generated: false,
            segments: Vec::new(),
            available_tracks: tracks,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub id: String,
    pub url: String,
    pub title: String,
    pub author: String,
    pub channel_url: Option<String>,
    pub channel_id: Option<String>,
    /// Дата публикации "YYYY-MM-DD" (доступна почти всегда из публичных данных).
    pub publish_date: Option<String>,
    /// Точные дата+время в RFC3339 — только если получены через YouTube Data API.
    pub publish_datetime_iso: Option<String>,
    pub duration_seconds: Option<u64>,
    pub view_count: Option<u64>,
    pub description: Option<String>,
    pub thumbnails: Vec<Thumbnail>,
    pub transcript: Transcript,
}
