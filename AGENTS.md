<div align="center">
  <h1>📋 AGENTS.md — Ivy Blog Bot</h1>
  <p><i>Complete technical reference for the Ivy ecosystem</i></p>

  <p>
    <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript"/>
    <img src="https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white" alt="Python"/>
    <img src="https://img.shields.io/badge/Cloudflare%20Workers-F38020?style=flat&logo=cloudflare&logoColor=white" alt="Cloudflare"/>
    <img src="https://img.shields.io/badge/Gemini-8E75FF?style=flat&logo=googlegemini&logoColor=white" alt="Gemini"/>
    <img src="https://img.shields.io/badge/CrewAI-FF6B6B?style=flat&logo=crewai&logoColor=white" alt="CrewAI"/>
    <img src="https://img.shields.io/badge/D1-003B5C?style=flat&logo=cloudflare&logoColor=white" alt="D1"/>
    <img src="https://img.shields.io/badge/Jekyll-CC0000?style=flat&logo=jekyll&logoColor=white" alt="Jekyll"/>
  </p>
</div>

---

## 🏗️ Overview

Two-layer project: **Telegram bot** (TypeScript, Cloudflare Worker) + **blog writer** (Python, CrewAI) + **blog host** (Jekyll/Chirpy, GitHub Pages).

### Data Flow

```
1. Telegram webhook POST → Worker (Hono + grammY)
   ├─ Dedup by update_id (in-memory Map, 10s TTL)
   ├─ Session loaded from D1 (d1SessionAdapter)
   ├─ Memories loaded from D1 → injected into system prompt
   ├─ Gemini API (chat + tool loop, max 5 turns)
   │  ├─ memory_save / memory_recall
   │  ├─ create_reminder / list_reminders / cancel_reminder
   │  ├─ search_web / fetch_url / get_current_time
   │  └─ get_movie_info / get_movie_recommendations / discover_movies
   ├─ Response sanitized (Telegram Markdown) → sent back
   └─ History capped at 10 messages → saved to D1

2. /write <topic> → GitHub Actions dispatch
   ├─ CrewAI pipeline (writer → humaniser → editor)
   ├─ Unsplash images → Jekyll frontmatter
   ├─ Commit to blog-source/_posts/
   ├─ Jekyll build → gh-pages deploy
   └─ Telegram notification
```

---

## 🚏 Entrypoints

| Layer | File | Purpose |
|-------|------|---------|
| 🟦 **Telegram Bot** | `src/index.ts` | Hono app, grammY bot, webhook, admin API, Discord stub |
| 🧠 **AI Engine** | `src/ai.ts` | Gemini API, tool loop, memory CRUD, movie tools, voice, PDF |
| 📝 **Blog Writer** | `src/blog_writing_crew/main.py` | `run()`, `train()`, `replay()`, `test()` |
| 🔧 **Writer Tools** | `src/blog_writing_crew/tools/custom_tool.py` | Tavily, Wikipedia, HN, ArXiv, OpenLibrary, RSS |
| 🖼️ **Publisher** | `scripts/publish_post.py` | Unsplash cover + frontmatter → Jekyll post |
| 🔍 **Topic Finder** | `scripts/find_trending_topic.py` | News API + Tavily → picks topic |
| 📖 **Blog Host** | `blog-source/` | Jekyll / Chirpy 7.5, `_posts/` |
| ⚙️ **CI/CD** | `.github/workflows/daily-telegram.yml` | 3x daily cron + manual dispatch |

---

## 🛣️ Hono Routes

| Method | Path | Handler |
|--------|------|---------|
| `POST` | `/` | Telegram webhook — parse update, create Bot, `webhookCallback` |
| `POST` | `/admin/posts` | List blog posts from GitHub (needs `ADMIN_PASSWORD`) |
| `POST` | `/admin/delete` | Delete post + trigger rebuild (needs `ADMIN_PASSWORD`) |
| `POST` | `/discord` | Discord interactions (Ed25519 verify → PONG → deferred) |
| `POST` | `/register-commands` | Bulk-register Discord slash commands |
| `POST` | `/chat-message` | Relay for Discord Gateway @mention |
| `GET` | `/init` | One-time D1 table creation |
| `GET` | `/migrate` | Migrate tables to TEXT chat_id |
| `GET` | `/` | Health check + `?command=set` webhook |

---

## 🧪 Commands

### Worker (TypeScript)
```bash
npm run dev          # wrangler dev (local)
npm run deploy       # wrangler deploy
npm run typecheck    # tsc --noEmit
```

### Blog Writer (Python)
```bash
uv sync                          # install deps
uv run crewai run                # write blog → output/blog_post.md
uv run python scripts/publish_post.py "topic"   # manual publish
crewai test -n 2 -m gpt-4o-mini  # test crew
```

### Full Pipeline
```bash
# Auto: GitHub Actions (3x daily)
# Manual: /write <topic> on Telegram

# Steps:
# uv sync → find_trending_topic.py → crewai run
# → publish_post.py → git commit → jekyll build → gh-pages → Telegram notification
```

---

## 🔐 Environment Variables

| Variable | Required | Used In | Purpose |
|----------|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | ✅ Yes | Bot, workflow | Telegram bot auth |
| `GEMINI_API_KEY` | ✅ Yes | `ai.ts`, `crew.py`, workflow | AI chat + Crew LLM |
| `GROQ_API_KEY` | ✅ Yes | `ai.ts` | Voice (Whisper) |
| `TAVILY_API_KEY` | ✅ Yes | Bot, crew, workflow | Web search tool |
| `GITHUB_PAT` | ✅ Yes | `index.ts` | GitHub Actions dispatch |
| `GITHUB_REPO` | ✅ Yes | `index.ts` | e.g. `Thirupathi-pirate/ivy` |
| `UNSPLASH_ACCESS_KEY` | ✅ Yes | `publish_post.py`, workflow | Blog cover images |
| `NEWS_API_KEY` | ✅ Yes | `find_trending_topic.py` | Trending topics |
| `TELEGRAM_CHAT_ID` | ✅ Yes | workflow | Notification recipient |
| `ADMIN_PASSWORD` | ❌ Optional | `index.ts` | Admin API access |
| `TMDB_API_KEY` | ❌ Optional | `ai.ts` | Enhanced movie tools |
| `REDDIT_CLIENT_ID` | ❌ Optional | `ai.ts` | Reddit search |
| `REDDIT_CLIENT_SECRET` | ❌ Optional | `ai.ts` | Reddit search |
| `REDDIT_USER_AGENT` | ❌ Optional | `ai.ts` | Reddit search |
| `DISCORD_BOT_TOKEN` | ❌ Optional | `index.ts` | Discord bot |
| `DISCORD_PUBLIC_KEY` | ❌ Optional | `index.ts` | Ed25519 verify |
| `DISCORD_APP_ID` | ❌ Optional | `index.ts` | Command registration |

> ⚠️ `.env` is **committed** to git. Do not add new secrets without user confirmation.

---

## ⚡ Model Chain

### Bot — 3-model Gemini fallback
```
gemini-2.5-flash-lite         (preferred — 30 RPM / 1,500 RPD / 1M TPM)
  → gemini-2.5-flash           (fallback 1)
  → gemini-3.1-flash-lite      (fallback 2)
```
**Rate limiting:** Detects 429, 503, Gemini error codes. Parses `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`. If all 3 models exhausted → *"I'm rate-limited across all models"*.

### Blog Writer (CrewAI)
```
Model: google/gemma-4-31b-it
Max tokens: 32768
Timeout: 300s
Retry: 3 attempts (exponential backoff: 30s, 60s, 120s on 5xx/timeout/connection errors)
```

---

## 🗄️ D1 Schema

```sql
-- Sessions (custom d1SessionAdapter)
CREATE TABLE sessions (
  chat_id TEXT PRIMARY KEY,
  data TEXT NOT NULL              -- JSON: { history: ChatMessage[], model: string }
);

-- Long-term memory (key-value per user)
CREATE TABLE memories (
  chat_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (chat_id, key)
);
CREATE INDEX idx_memories_chat_id ON memories(chat_id);

-- Reminders (cron-fired)
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,     -- epoch ms
  message TEXT NOT NULL
);
CREATE INDEX idx_reminders_timestamp ON reminders(timestamp);
```

**History cap:** system prompt + 9 most recent user/assistant turns.

---

## 🛠️ Tool Definitions

Ivy's tool loop uses GOAP-style detection — `needsTools()` checks messages for trigger keywords before attaching tool definitions, saving tokens on simple queries.

### 🧠 Memory
| Tool | Description |
|------|-------------|
| `memory_save(key, value)` | Save a fact/preference to D1 (upserts) |
| `memory_recall(key?)` | Recall saved facts — specific key or all |

### ⏰ Reminders
| Tool | Description |
|------|-------------|
| `create_reminder(time, message)` | Schedule — HH:MM (24h) or ISO date. Returns ID + timestamp |
| `list_reminders()` | List all active reminders with relative time |
| `cancel_reminder(reminder_id)` | Cancel by ID. Returns success/not_found |

### 🌐 Web
| Tool | Description |
|------|-------------|
| `search_web(query)` | Tavily search (`include_answer: true`), summary + 5 results |
| `fetch_url(url)` | Fetch URL content (first 8000 chars) |

### 🕐 Time
| Tool | Description |
|------|-------------|
| `get_current_time(timezone?)` | UTC or IANA timezone (e.g. `Asia/Kolkata`) |

### 🎬 Movies (3-source fallback)
| Tool | Chain | Description |
|------|-------|-------------|
| `get_movie_info(title, year?)` | TMDB → Reddit (r/movies, r/moviecritic, r/TrueFilm) → Tavily | Rating, year, genres, overview + community posts |
| `get_movie_recommendations(title)` | TMDB → Reddit (r/MovieSuggestions, r/ifyoulikeblank) → Tavily | Similar movie suggestions |
| `discover_movies(genres?, min_rating?, year?)` | TMDB discover → Reddit search → Tavily | Find by genre/rating/year |

---

## ⏲️ Reminder System

```
Cron: * * * * * (every minute)
Query: reminders WHERE timestamp <= now
Delivery: Telegram sendMessage (Markdown)
Cleanup: DELETE on success
```

- **HH:MM** → today at that UTC time (or tomorrow if past)
- **ISO date** → absolute timestamp
- **IDs** → 8-char random UUID prefix

---

## 🖼️ Image / Voice / File Handling

### 📸 Photos
```
1. Get largest photo from Telegram file API
2. Convert to base64 data URI → Gemini as inline image
3. Stream response (500-char reveal steps)
4. Strip image data from stored history (save KV quota)
```

### 🎤 Voice
```
1. Download OGG via Telegram API
2. Groq Whisper (whisper-large-v3-turbo) transcription
3. Feed transcript back into chat flow
```

### 📄 Documents
| Type | Handling |
|------|----------|
| **PDF** | Raw bytes → TextDecoder → extract `/Info` metadata + `Tj`/`TJ`/`'`/`"` text ops. Decodes escape sequences. Returns first 10K chars |
| **Text** (`.txt .csv .json .xml .md .html .log .yaml .toml .py .js .ts .rs .go .java .c .cpp .h .sql .rb .php .sh` + more) | UTF-8, truncated at 10K chars |

### 📐 LaTeX
`$$...$$` or `\[...\]` → QuickLaTeX POST → PNG → `sendPhoto`. Fire-and-forget.

### 🧮 Mermaid
```` ```mermaid `` → base64url encode → `mermaid.ink/img/` PNG → `sendPhoto`. Fire-and-forget.

---

## 👥 CrewAI Pipeline

Three agents running sequentially:

```
┌──────────┐     ┌────────────┐     ┌────────┐
│  Writer  │────→│ Humaniser  │────→│ Editor │
│(research)│     │ (rewrite)  │     │(polish)│
└──────────┘     └────────────┘     └────────┘
```

### ✍️ Writer
- **Tools:** `news_search` (Tavily), `wikipedia_search`, `hackernews_search` (Algolia), `arxiv_search`, `openlibrary_search`, `rss_feed` (feedparser)
- Researches across all sources — verifiable facts, statistics, real user quotes, academic papers
- Writes **≥2500 words** — 8 sections + intro + conclusion
- Emoji headers, Mermaid diagrams, blockquotes, bullet lists, inline source links
- Self-verifies every claim has a source URL

### 🗣️ Humaniser
- Rewrites to natural conversational tone
- No AI jargon, no corporate language
- Preserves all facts, source attributions, visual formatting
- Removes unsourced claims entirely (no `[UNVERIFIED]` markers)

### ✅ Editor
- Grammar, spelling, formatting polish
- Fact-checks every claim against provided sources
- Removes or rephrases unsupported statements
- Publication-ready output with clean markdown

### Retry Logic
```python
for attempt in 1..3:
    try:
        crew.kickoff()
    except (5xx, timeout, connection error):
        wait(2^attempt * 30s)
    else:
        break
```

---

## 📖 Blog Host (`blog-source/`)

Jekyll site — **Chirpy 7.5** — **Midnight Purple** theme.

### Key Files

| Path | Purpose |
|------|---------|
| `_sass/custom/custom.scss` | Midnight Purple theme (bg `#12121E`, accent `#BB86FC`) |
| `_includes/custom/head.html` | Mermaid dark-theme, OG tags, JSON-LD, favicon, canonical |
| `_includes/custom/tail.html` | Unsplash download-tracking JS |
| `_includes/custom/post.html` | Related posts section |
| `_includes/breadcrumb.html` | Breadcrumb nav + JSON-LD |
| `_includes/footer.html` | Custom footer + GitHub link |
| `_tabs/about.md` | About page |
| `404.html` | Custom 404 |
| `robots.txt` | Crawl rules |
| `sitemap.xml` | Auto-generated (`jekyll-sitemap`) |

### 🧮 Mermaid
- Dark theme via `window.mermaid` (theme: `base`, purple accents)
- SCSS overrides: purple strokes/edges, custom font
- Frontmatter `mermaid: true` required

### 🔍 SEO
- `jekyll-sitemap` → `sitemap.xml`
- `jekyll-last-modified-at` → `lastmod` in sitemap
- `robots.txt` → allow all, point to sitemap
- `head.html`: canonical URL, meta description, OG tags, Twitter cards, JSON-LD `BlogPosting`
- Google Search Console placeholder
- Page title: **Ivy** / Tagline: *"Daily thoughts on tech, science & culture"*
- JSON-LD: WebSite (knowledge panel + search action) + BlogPosting (dates, author, publisher, image, keywords)
- Breadcrumb JSON-LD + `article:section` for category
- Preconnect/dns-prefetch for Google Fonts + Unsplash
- `theme-color: #12121E` for mobile browser UI
- **No AI references** — reads as a human editorial blog

### ⚡ Performance
| Technique | Detail |
|-----------|--------|
| **Fonts** | `<link>` in head (not CSS `@import`) — fetch starts during HTML parsing |
| **Preload** | Inter + Spectral with `as="style"` |
| **Non-blocking** | Playfair Display: `media="print" onload="this.media='all'"` |
| **CLS prevention** | Avatar `aspect-ratio: 1`; inline images have explicit `width`/`height` |
| **Lazy loading** | `loading="lazy"` + `data-unsplash-dl` on inline images |
| **Preconnect** | Early connection to Google Fonts + Unsplash |

### 🖼️ Publishing Pipeline (`scripts/publish_post.py`)
1. Read crew output from `output/blog_post.md`
2. Fetch **2 Unsplash images** (cover + inline)
3. Detect `mermaid` code blocks → `mermaid: true`
4. Detect LaTeX (`$$`, `\[`, `\text`, `\sum`, Greek letters, etc.) → `math: true`
5. Write to `blog-source/_posts/YYYY-MM-DD-slug.md`
6. Graceful fallback to 0–1 images if Unsplash fails

### 🎨 UX Features
- **Page fade-in** — opacity + slide-up animation
- **Breadcrumbs** — schema-backed navigation
- **Related posts** — 3 most recent articles
- **Reading progress** — gradient purple progress bar
- **Share buttons** — Twitter, LinkedIn, Telegram
- **Smooth scroll** — `scroll-behavior: smooth`

### 🖌️ Avatar & Favicon
| Asset | Source | Specs |
|-------|--------|-------|
| Avatar | `assets/avatar.webp` | 192×192, circular, purple border |
| Logo | `/logo.png` | 233×196, center-cropped to square |
| Favicons | `assets/img/favicons/` | `.ico` + 16×16 + 32×32 + 96×96 PNG + apple-touch-icon 180×180 |

---

## ⚙️ CI/CD Workflow

### `.github/workflows/daily-telegram.yml`

```yaml
on:
  schedule:
    - cron: "20 0 * * *"    # 5:50 AM IST → tech
    - cron: "30 4 * * *"    # 10:00 AM IST → general
    - cron: "0 12 * * *"    # 5:30 PM IST → general
  workflow_dispatch:
    inputs:
      topic:
        description: "Blog topic"
```

**Steps:**
```
1. uv sync                    ─ Install Python deps
2. find_trending_topic.py     ─ Auto-discover topic (skipped if topic input provided)
   --type tech|general
3. crewai run                 ─ Write blog via CrewAI
4. publish_post.py            ─ Unsplash images + Jekyll frontmatter
5. git add + commit + push    ─ Commit to main [skip ci]
6. jekyll build               ─ Build site
7. gh-pages deploy            ─ Deploy
8. Telegram notification       ─ sendMessage to TELEGRAM_CHAT_ID
```

**Tech vs General:** UTC 00:20 (IST 5:50 AM) → tech; UTC 04:30 (IST 10:00 AM) → general; UTC 12:00 (IST 5:30 PM) → general.

---

## 🔍 Topic Finder (`scripts/find_trending_topic.py`)

| Flag | Source | Filter |
|------|--------|--------|
| `--type tech` | News API (`category=technology`) + Tavily | 200+ tech keywords (AI, crypto, cloud, hardware, EV, gaming, programming...) |
| `--type general` | News API (`category=general`) + Tavily | Excludes tech keywords |

- Deduplicates by lowercase title (strips trailing `.?!`)
- Randomly picks from top 20 candidates
- Falls back to default topic if no candidates found

---

## 📐 Style / Conventions

| Area | Convention |
|------|-----------|
| **TypeScript** | strict mode, ES2022 target, `@cloudflare/workers-types`, `isolatedModules: true` |
| **CrewAI** | `@CrewBase` decorator + YAML (`agents.yaml`, `tasks.yaml`) |
| **Blog posts** | `_posts/YYYY-MM-DD-title.md` — Chirpy frontmatter |
| **Git** | Conventional commits. CI commits `[skip ci]` |
| **`.env`** | Committed to git — do not add secrets without confirmation |
| **Legacy** | `cloudflare-worker.js` — do not edit/deploy. Active: `src/index.ts` + `src/ai.ts` |

---

## ⚙️ Wrangler Config

```toml
name = "ivy-blog-bot"
main = "src/index.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "IVY_KV"
id = "9dfd92f4487a4c0aa6114b60b5c9127b"

[[d1_databases]]
binding = "IVY_DB"
database_name = "ivy-blog-bot"
database_id = "9d3bfed4-e4af-446c-85aa-0011fcab103f"

[triggers]
crons = ["* * * * *"]

[vars]
DISCORD_APP_ID = "1521363304579338330"
DISCORD_PUBLIC_KEY = "ccf47e87e294ed5440b46b2dc3c10ab1ba3a6c121627f46e2a666bce8ffcd22b"
```

> KV is declared but **not actively used** — Telegram session adapter uses an in-memory Map (10s TTL) to save KV quota. D1 is the primary store.

---

## 📌 Key Constraints

| Constraint | Detail |
|-----------|--------|
| **Blog posts** | ≥2500 words, 8 sections + intro + conclusion, emoji headers, Mermaid, blockquotes, source links |
| **Bot persona** | Ivy — warm, female, friendly AI assistant |
| **Session history** | D1 via `d1SessionAdapter()`, last ~10 messages (system + 9 recent) |
| **Reminders** | D1-backed, `* * * * *` cron |
| **Tool loop** | Max 5 turns per message |
| **Message dedup** | In-memory Map, `update_id`, 10s TTL, max 100 entries |
| **Tests** | `tests/` dir exists but empty |
