// Контракт данных между Rust-бэкендом и фронтендом.
// Rust-структуры сериализуются с #[serde(rename_all = "camelCase")] — поля совпадают.

export interface Thumbnail {
  url: string;
  width: number;
  height: number;
  label: string; // "maxres" | "sd" | "hq" | "mq" | "default"
}

export interface TranscriptSegment {
  start: number; // секунды
  dur: number; // секунды
  text: string;
}

export interface TranscriptTrack {
  langCode: string; // "ru", "en", "en-US"
  langName: string; // "Russian", "English"
  isGenerated: boolean; // авто-субтитры (ASR)
}

export interface Transcript {
  available: boolean;
  langCode: string | null;
  langName: string | null;
  isGenerated: boolean;
  segments: TranscriptSegment[];
  availableTracks: TranscriptTrack[];
}

export interface VideoInfo {
  id: string;
  url: string;
  title: string;
  author: string;
  channelUrl: string | null;
  channelId: string | null;

  // publishDate — "YYYY-MM-DD". publishDatetimeIso — полный RFC3339 с временем, если доступно.
  publishDate: string | null;
  publishDatetimeIso: string | null;

  durationSeconds: number | null;
  viewCount: number | null;
  description: string | null;
  thumbnails: Thumbnail[];
  transcript: Transcript;
}

export type ExportFormat = "txt" | "srt" | "vtt";
export type Theme = "dark" | "light" | "system";
export type Density = "compact" | "regular" | "comfy";
export type TranscriptView = "flow" | "timecoded"; // сплошной текст | по сегментам с таймкодами

export interface Settings {
  theme: Theme;
  accent: string; // hex
  density: Density;
  defaultLang: string; // "auto" | langCode
  transcriptView: TranscriptView;
  showTimecodes: boolean;
  exportFormat: ExportFormat;
  apiKey: string; // YouTube Data API key (опционально — резерв для точного времени)
}
