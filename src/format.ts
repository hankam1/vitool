// Утилиты форматирования: время, числа, экспорт транскрипта (TXT/SRT/VTT).

import type { TranscriptSegment, VideoInfo, ExportFormat } from "./types";

/** Секунды → "M:SS" или "H:MM:SS" (для таймкодов в списке). */
export function fmtTimecode(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Секунды → "HH:MM:SS,mmm" (SRT) или "HH:MM:SS.mmm" (VTT). */
function fmtStamp(totalSeconds: number, sep: "," | "."): string {
  const ms = Math.round((totalSeconds % 1) * 1000);
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}${sep}${pad(ms, 3)}`;
}

/** Длительность видео → "10:24" / "1:02:03". */
export function fmtDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  return fmtTimecode(seconds);
}

/** Просмотры → "1 234 567" (разрядность пробелами). */
export function fmtViews(n: number | null): string | null {
  if (n == null) return null;
  return n.toLocaleString("ru-RU");
}

const MONTHS_RU = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

/**
 * Человекочитаемые дата и время.
 * Если есть точный ISO (Data API) — "12 мая 2023, 14:30".
 * Иначе только дата — "12 мая 2023".
 * Возвращает { date, time } чтобы UI мог показать раздельно.
 */
export function fmtPublished(info: VideoInfo): { date: string | null; time: string | null } {
  if (info.publishDatetimeIso) {
    const d = new Date(info.publishDatetimeIso);
    if (!isNaN(d.getTime())) {
      const date = `${d.getDate()} ${MONTHS_RU[d.getMonth()]} ${d.getFullYear()}`;
      const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return { date, time };
    }
  }
  if (info.publishDate) {
    // "YYYY-MM-DD"
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(info.publishDate);
    if (m) {
      const y = +m[1], mo = +m[2] - 1, day = +m[3];
      return { date: `${day} ${MONTHS_RU[mo]} ${y}`, time: null };
    }
    return { date: info.publishDate, time: null };
  }
  return { date: null, time: null };
}

/** Экранирование для безопасной вставки в HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Абзац сплошного текста, собранный из коротких субтитр-сегментов. */
export interface Paragraph {
  text: string; // склеенный, нормализованный текст
  start: number; // время начала первого сегмента (сек)
  from: number; // индекс первого сегмента
  to: number; // индекс последнего сегмента
}

/** Заканчивается ли фрагмент знаком конца предложения (учитывая закрывающую кавычку/скобку). */
function endsSentence(t: string): boolean {
  return /[.!?…]["»”'’)\]]*$/.test(t);
}

/**
 * Склеить короткие сегменты субтитров в читаемые абзацы.
 * Разрыв делается ТОЛЬКО на конце предложения и не раньше MIN символов —
 * поэтому каждый абзац (кроме, возможно, последнего) заканчивается точкой.
 * Если знаков препинания нет вовсе (авто-субтитры без пунктуации) — выйдет один блок.
 */
export function buildParagraphs(segments: TranscriptSegment[]): Paragraph[] {
  const MIN = 480; // не разбивать раньше этого числа символов
  const out: Paragraph[] = [];
  let parts: string[] = [];
  let start = 0, from = 0, chars = 0, last = "";

  const flush = (to: number) => {
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (text) out.push({ text, start, from, to });
    parts = []; chars = 0; last = "";
  };

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const txt = s.text.replace(/\s+/g, " ").trim();
    if (!txt) continue;
    if (parts.length === 0) {
      start = s.start; from = i;
    } else if (chars >= MIN && endsSentence(last)) {
      flush(i - 1); start = s.start; from = i;
    }
    parts.push(txt); chars += txt.length + 1; last = txt;
  }
  // финальный сброс: остаток. Без пунктуации цикл ни разу не разрывает —
  // значит сюда попадает весь текст одним блоком.
  flush(segments.length - 1);

  return out;
}

/** Собрать текст экспорта в выбранном формате. */
export function buildExport(
  segments: TranscriptSegment[],
  format: ExportFormat,
  opts: { withTimecodes: boolean; title?: string }
): string {
  if (format === "txt") {
    if (opts.withTimecodes) {
      return segments.map((s) => `[${fmtTimecode(s.start)}] ${s.text}`).join("\n");
    }
    // без таймкодов — сплошной текст абзацами, как у конкурентов
    return buildParagraphs(segments).map((p) => p.text).join("\n\n");
  }

  if (format === "srt") {
    return segments
      .map((s, i) => {
        const end = s.start + (s.dur || 2);
        return `${i + 1}\n${fmtStamp(s.start, ",")} --> ${fmtStamp(end, ",")}\n${s.text}\n`;
      })
      .join("\n");
  }

  // vtt
  const head = "WEBVTT\n";
  const body = segments
    .map((s) => {
      const end = s.start + (s.dur || 2);
      return `${fmtStamp(s.start, ".")} --> ${fmtStamp(end, ".")}\n${s.text}\n`;
    })
    .join("\n");
  return `${head}\n${body}`;
}

/** Безопасное имя файла из заголовка видео. */
export function safeFilename(title: string, fallback = "transcript"): string {
  const base = (title || fallback)
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return base || fallback;
}
