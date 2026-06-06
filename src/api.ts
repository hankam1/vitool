// Обёртки над Tauri-командами и плагинами.

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { VideoInfo, Transcript } from "./types";

/** Получить всю информацию о видео (метаданные + транскрипт по умолчанию). */
export function fetchVideo(url: string, apiKey?: string): Promise<VideoInfo> {
  return invoke<VideoInfo>("fetch_video", { url, apiKey: apiKey || null });
}

/** Получить транскрипт в конкретном языке (переключение дорожки). */
export function fetchTranscript(videoId: string, langCode: string, isGenerated: boolean): Promise<Transcript> {
  return invoke<Transcript>("fetch_transcript", { videoId, langCode, isGenerated });
}

/** Скачать файл (превью) по URL в указанный путь — выполняется в Rust (без CORS). */
export function downloadFile(url: string, destPath: string): Promise<void> {
  return invoke<void>("download_file", { url, destPath });
}

/** Записать текстовый файл по абсолютному пути — выполняется в Rust (без scope-ограничений fs-плагина). */
export function saveText(path: string, contents: string): Promise<void> {
  return invoke<void>("save_text", { path, contents });
}

/** Открыть внешнюю ссылку в браузере (через Rust — минуя scope JS-плагина). */
export function openExternal(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}

/** Чтение буфера обмена (для кнопки «Вставить»). */
export async function clipboardRead(): Promise<string> {
  try {
    return (await readText()) ?? "";
  } catch {
    return "";
  }
}

/** Запись в буфер обмена. */
export function clipboardWrite(text: string): Promise<void> {
  return writeText(text);
}

/** Диалог «Сохранить как…» для текстового файла. */
export async function saveTextFile(
  contents: string,
  defaultName: string,
  ext: string,
  filterName: string
): Promise<boolean> {
  const path = await save({
    defaultPath: `${defaultName}.${ext}`,
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (!path) return false;
  await saveText(path, contents);
  return true;
}

/** Диалог «Сохранить как…» для изображения (скачивание через Rust). */
export async function saveImageFile(
  url: string,
  defaultName: string,
  ext = "jpg"
): Promise<boolean> {
  const path = await save({
    defaultPath: `${defaultName}.${ext}`,
    filters: [{ name: "Изображение", extensions: [ext, "png", "webp"] }],
  });
  if (!path) return false;
  await downloadFile(url, path);
  return true;
}
