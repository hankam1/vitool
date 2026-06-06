# viTool — Техническая документация

## 1. Назначение

Лёгкое кросс-платформенное desktop-приложение: пользователь вставляет ссылку на
YouTube-видео и получает:

- **транскрипт** (скрипт) видео — список сегментов «таймкод + текст»;
- **превью** (обложку) с кнопками скачивания в разных разрешениях;
- **дату и время публикации**, а также канал, длительность, число просмотров.

Дополнительно: поиск по транскрипту, копирование, экспорт в **TXT / SRT / VTT**,
переключение языка субтитров, открытие видео на YouTube.

---

## 2. Почему такой стек (и почему «лёгкий»)

| Решение | Обоснование |
|---|---|
| **Tauri 2** (а не Electron) | Использует системный WebView вместо встроенного Chromium → бинарник **~5–10 МБ** против ~120+ МБ у Electron. Память — десятки МБ. |
| **Rust backend** | Сетевые запросы и парсинг идут нативно, без CORS-ограничений webview, быстро и безопасно. |
| **reqwest + rustls** (не native-tls) | Чистый Rust-TLS со встроенными корневыми сертификатами → нет зависимости от OpenSSL, одинаково собирается на всех ОС, меньше вес. |
| **Vanilla TypeScript + Vite** (без React) | Нет рантайма фреймворка → минимальный JS-бандл (десятки КБ). UI несложный, фреймворк избыточен. |
| **Никакого FFmpeg / yt-dlp** | Мы НЕ скачиваем и не перекодируем видео. Нужны только текст (субтитры), картинка (обложка) и метаданные — всё это обычные HTTP-запросы. Это и есть ключ к «лёгкости». |
| **Запись файлов в Rust** | Сохранение через собственную команду `save_text` / `download_file`, а не через fs-плагин → не нужен scope-конфиг, любой выбранный в диалоге путь работает. |

Оценка артефактов (release, примерно):
- Windows `.msi`/`.exe`: ~6–10 МБ (WebView2 уже есть в системе).
- macOS `.dmg`: ~8–12 МБ.
- Linux `.AppImage`: ~10–15 МБ (включает webkit2gtk-зависимости динамически).

---

## 3. Архитектура

```
┌────────────────────────────────────────────────────────────┐
│                      WebView (frontend)                      │
│  index.html · styles.css · main.ts (vanilla TS + Vite)       │
│  ─ ввод URL, рендер превью/мета/транскрипта, поиск, экспорт   │
│  ─ диалоги сохранения, буфер обмена, управление окном        │
└───────────────▲───────────────────────────┬─────────────────┘
                │ invoke()                    │ результат (JSON)
                │                             ▼
┌───────────────┴───────────────────────────────────────────── ┐
│                       Rust core (Tauri)                        │
│  lib.rs   — регистрация команд и плагинов                      │
│  youtube.rs — извлечение данных:                               │
│     1) player response (watch-страница → fallback InnerTube)   │
│     2) субтитры (captionTracks.baseUrl + fmt=json3)            │
│     3) метаданные (videoDetails + microformat)                 │
│     4) (опц.) точное время через YouTube Data API v3           │
│  models.rs — сериализуемые структуры (camelCase)              │
└───────────────┬───────────────────────────────────────────────┘
                │ HTTPS (reqwest/rustls)
                ▼
        youtube.com · i.ytimg.com · googleapis.com
```

---

## 4. Структура проекта

```
viTool/
├── index.html                # каркас UI + спрайт иконок
├── package.json              # фронт-зависимости и скрипты
├── vite.config.ts
├── tsconfig.json
├── app-icon.png              # исходник иконки (→ tauri icon)
├── scripts/gen-icon.cjs      # генератор исходной иконки
├── src/                      # FRONTEND (vanilla TS)
│   ├── main.ts               # логика, рендер, события
│   ├── api.ts                # обёртки invoke + плагины
│   ├── types.ts              # контракт данных
│   ├── format.ts             # время, экспорт TXT/SRT/VTT
│   ├── store.ts              # настройки (localStorage)
│   ├── toast.ts              # уведомления
│   ├── styles.css            # дизайн-система (токены)
│   └── vite-env.d.ts
├── src-tauri/                # BACKEND (Rust)
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   ├── icons/                # генерируются `tauri icon`
│   └── src/
│       ├── main.rs
│       ├── lib.rs            # команды Tauri
│       ├── youtube.rs        # извлечение
│       └── models.rs         # модели
└── docs/
    ├── TECH.md               # этот файл
    └── DESIGN_BRIEF.md       # бриф для дизайна
```

---

## 5. Контракт данных (команды Tauri)

| Команда | Параметры | Возврат |
|---|---|---|
| `fetch_video` | `url: string`, `api_key?: string` | `VideoInfo` |
| `fetch_transcript` | `video_id`, `lang_code`, `is_generated` | `Transcript` |
| `download_file` | `url`, `dest_path` | `void` (скачивает превью) |
| `save_text` | `path`, `contents` | `void` (экспорт) |

Структуры сериализуются с `#[serde(rename_all = "camelCase")]`, поэтому поля во
фронтенде — camelCase (см. `src/types.ts`). Ключевые поля `VideoInfo`:
`id, url, title, author, channelUrl, channelId, publishDate, publishDatetimeIso,
durationSeconds, viewCount, description, thumbnails[], transcript`.

---

## 6. Поток получения данных

> ⚠️ Метод выверен по результатам исследования (yt-dlp PO Token wiki и
> youtube-transcript-api, проверка на живых видео 2026-06-05). Два неочевидных факта
> определяют архитектуру:
> 1. **WEB-клиент для субтитров больше не работает** — его `baseUrl` теперь
>    PoToken-gated и отдаёт пустой ответ. Рабочие дорожки даёт **ANDROID InnerTube**.
> 2. **Точное время публикации доступно БЕЗ ключа** — `microformat.publishDate` на
>    watch-странице теперь содержит полный таймстемп с временем и таймзоной.

### 6.1 Транскрипт (источник — ANDROID InnerTube)
1. Из URL извлекается и валидируется 11-символьный `videoId` (`^[A-Za-z0-9_-]{11}$`; поддержка `watch`, `youtu.be`, `shorts`, `embed`, `live`).
2. POST `https://www.youtube.com/youtubei/v1/player?key=…` с контекстом клиента **ANDROID** (`clientVersion 20.10.38`, UA Android-приложения). Этот клиент **не требует PoToken** для субтитров.
3. Берётся `captions.playerCaptionsTracklistRenderer.captionTracks[]`. Выбор дорожки: ручная приоритетнее авто (`kind="asr"`).
4. **Защита от PoToken:** если `baseUrl` содержит `exp=xpe`, клиент пропускается — пробуется цепочка **TVHTML5_SIMPLY_EMBEDDED_PLAYER → WEB_EMBEDDED_PLAYER** (оба не требуют токен).
5. Скачивается `baseUrl` с `&fmt=json3` → `events[]`; для каждого (где есть `segs`): `start = tStartMs/1000`, `dur = dDurationMs/1000`, текст = склейка `segs[].utf8`.
6. **XML-фолбэк:** если json3 пуст/не парсится — тот же `baseUrl` без `fmt` → разбор `<text start dur>` с HTML-деэкранированием.

### 6.2 Метаданные (источник — watch-страница)
- GET `https://www.youtube.com/watch?v=ID` с десктопным UA и cookie `SOCS=CAI` (обход EU-интерстициала). Из HTML вырезается сбалансированный JSON `ytInitialPlayerResponse` (свой парсер скобок с учётом строк/экранирования — без хрупких regex).
- `videoDetails`: `title, author, channelId, lengthSeconds, viewCount, shortDescription`.
- `microformat.playerMicroformatRenderer`: `publishDate / uploadDate` (полный RFC3339 с временем), `ownerProfileUrl`.
- Если watch-страница недоступна (consent-wall и т.п.) — `videoDetails` берутся из ANDROID-ответа (без точной даты).

### 6.3 Превью
URL обложек YouTube предсказуемы по `videoId`:
`https://i.ytimg.com/vi/<id>/<name>.jpg`, где `name ∈ {maxresdefault, sddefault, hqdefault, mqdefault, default}`.
Главное превью пытается `maxresdefault` и откатывается на `hqdefault` (не у всех видео есть maxres).

---

## 7. Дата и время публикации

- **Дата и точное время** обычно доступны **без какого-либо ключа**: поле
  `microformat.playerMicroformatRenderer.publishDate` на watch-странице по состоянию
  на 2026 содержит полный таймстемп с временем и таймзоной, напр.
  `2009-10-24T23:57:33-07:00` (проверено на нескольких видео 2026-06-05).
- Бэкенд разбирает это в два поля: `publishDate` (`YYYY-MM-DD`) и `publishDatetimeIso`
  (полный RFC3339). Парсер принимает **и** полный таймстемп, **и** «голую» дату — на
  случай, если YouTube вернёт формат без времени.
- **Резерв:** если времени в данных всё же нет, а в настройках задан
  **YouTube Data API v3 ключ**, бэкенд вызывает
  `GET https://www.googleapis.com/youtube/v3/videos?part=snippet&id=ID&key=KEY`
  и берёт `snippet.publishedAt` → `publishDatetimeIso`.
- UI: дата (+время, если есть) показываются заметной строкой; если только дата —
  мягкая подсказка про резервный ключ.

Ключ хранится локально (localStorage), запросы к Data API идут напрямую с устройства.

> Историческая справка: ранее точное время приходилось брать только через Data API
> (в `microformat` была лишь дата). К 2026 YouTube стал отдавать полный таймстемп в
> публичном HTML — поэтому ключ из обязательного стал необязательным резервом.

---

## 8. Экспорт транскрипта

Формируется во фронтенде из сегментов (`src/format.ts`):
- **TXT** — текст (опц. с таймкодами `[M:SS]`);
- **SRT** — нумерованные блоки с `HH:MM:SS,mmm`;
- **VTT** — заголовок `WEBVTT` + блоки с `HH:MM:SS.mmm`.

Сохранение: диалог `save` (dialog-плагин) → путь → Rust `save_text`.

---

## 9. Безопасность и права

- **Capabilities** (`src-tauri/capabilities/default.json`) — принцип минимальных прав: окно (drag/min/max/close), `opener:allow-open-url`, `dialog:allow-save`, `clipboard-manager` read/write. Запись файлов — собственными Rust-командами, fs-плагин не подключён.
- **CSP**: `img-src` разрешает только `i.ytimg.com` (превью); скрипты/стили — `self`.
- Бэкенд ходит только на `youtube.com`, `i.ytimg.com`, `googleapis.com`.

---

## 10. Риски и устойчивость

| Риск | Митигизация |
|---|---|
| YouTube меняет разметку/эндпоинты | Двойной путь получения player response (watch-страница + InnerTube), свой устойчивый парсер JSON. При поломке достаточно поправить `youtube.rs`. |
| Требование PoToken для субтитров | Если WEB-клиент перестанет отдавать `captionTracks`, переключиться на другой InnerTube-клиент или добавить генерацию токена. Архитектура это локализует в одной функции. |
| У видео нет субтитров | Корректное пустое состояние; превью и дата всё равно показываются. |
| Возрастные/приватные видео | `playabilityStatus` проверяется → понятное сообщение об ошибке. |
| maxres-превью отсутствует | Фолбэк на hqdefault на стороне фронта. |

---

## 11. Легальность и этика

Приложение получает **только публично доступные** данные (метаданные, обложку,
субтитры) и не скачивает сам видеопоток. Тем не менее использование должно
соответствовать [Условиям использования YouTube](https://www.youtube.com/t/terms).
Ответственность за конкретное применение (например, массовый сбор) — на пользователе.
Для официального и стабильного доступа к метаданным рекомендуется YouTube Data API.

---

## 12. Возможные улучшения (roadmap)

- Виртуализация списка сегментов для очень длинных видео (сейчас полный рендер).
- Кэш player response между `fetch_video` и `fetch_transcript` (сейчас повторный запрос при смене языка).
- История запросов; пакетная обработка нескольких ссылок.
- Перевод субтитров через `tlang` (translated tracks).
- Светлая тема (токены уже подготовлены).
