// Простое хранилище настроек в localStorage (без внешних зависимостей).

import type { Settings } from "./types";

const KEY = "vitool.settings";

export const ACCENTS: Record<string, { hover: string; active: string; subtle: string; ring: string }> = {
  "#0A84FF": { hover: "#409CFF", active: "#0060DF", subtle: "rgba(10,132,255,0.14)", ring: "rgba(10,132,255,0.55)" },
  "#5E5CE6": { hover: "#7D7BFF", active: "#4240C4", subtle: "rgba(94,92,230,0.16)", ring: "rgba(94,92,230,0.55)" },
  "#2DC7C0": { hover: "#54DDD6", active: "#1C9C96", subtle: "rgba(45,199,192,0.16)", ring: "rgba(45,199,192,0.5)" },
  "#FF6482": { hover: "#FF8298", active: "#E04467", subtle: "rgba(255,100,130,0.16)", ring: "rgba(255,100,130,0.5)" },
};

const DEFAULTS: Settings = {
  theme: "dark",
  accent: "#5E5CE6", // фиолетовый — стандарт (цвет больше не настраивается)
  density: "regular",
  defaultLang: "auto",
  transcriptView: "flow",
  showTimecodes: true,
  exportFormat: "srt",
  apiKey: "",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const s = { ...DEFAULTS, ...JSON.parse(raw) } as Settings;
    // акцент и плотность больше не настраиваются — всегда стандартные
    s.accent = DEFAULTS.accent;
    s.density = DEFAULTS.density;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
