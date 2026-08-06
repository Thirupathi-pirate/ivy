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
   ├─ Dedup by update_id (D1 `INSERT OR IGNORE` + in-memory fast path)
   ├─ ACK Telegram instantly, then AI loop runs in `waitUntil` (30s budget — beats the ~10s free-plan webhook wall)
   ├─ Session loaded from D1 (d1SessionAdapter) — per-chat serialized
   ├─ Memories loaded from D1 → injected into system prompt
   ├─ Gemini API (chat + tool loop, max 5 turns)
   │  ├─ memory_save / memory_recall
   │  ├─ create_reminder / list_reminders / cancel_reminder
   │  ├─ search_web / fetch_url / browse_url / screenshot_url / get_current_time
   │  └─ get_movie_info / get_movie_recommendations / discover_movies
   ├─ Response sanitized (Telegram Markdown) → sent back
   ├─ History capped at 10 messages → saved to D1
   └─ Proactive autosave: awaited extraction pass (first 5 fallback models,
       budget-guarded at >20s AI-loop elapsed) persists durable user facts
       (memories + knowledge graph, source='autosave') even when the model
       never called memory_save

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
| 🟦 **Telegram Bot** | `src/index.ts` | Hono app, grammY bot, webhook, admin API |
| 🧠 **AI Engine** | `src/ai.ts` | Gemini API, tool loop, memory CRUD, movie tools, voice, PDF |
| 📝 **Blog Writer** | `src/blog_writing_crew/main.py` | `run()`, `train()`, `replay()`, `test()` |
| 🔧 **Writer Tools** | `src/blog_writing_crew/tools/custom_tool.py` | Tavily, Wikipedia, HN, ArXiv, OpenLibrary, RSS |
| 🖼️ **Publisher** | `scripts/publish_post.py` | Unsplash cover + frontmatter → Jekyll post |
| 🔍 **Topic Finder** | `scripts/find_trending_topic.py` | News API + Tavily → picks topic |
| 📖 **Blog Host** | `blog-source/` | Jekyll / Chirpy 7.5, `_posts/` |
| ⚙️ **CI/CD** | `.github/workflows/blog-writer.yml` | 4x daily cron + manual dispatch (also `repair-posts.yml` every 6h) |

---

## 🛣️ Hono Routes

| Method | Path | Handler |
|--------|------|---------|
| `POST` | `/` | Telegram webhook — parse update, D1 dedup, ACK instantly, AI loop in `waitUntil` (30s budget) |
| `POST` | `/admin/posts` | List blog posts from GitHub (needs `ADMIN_PASSWORD`) |
| `POST` | `/admin/delete` | Delete post + trigger rebuild (needs `ADMIN_PASSWORD`) |
| `POST` | `/admin/commands` | Re-register Telegram command menu (`setMyCommands`) + return BotFather paste text (needs `ADMIN_PASSWORD`) |
| `GET` | `/init` | One-time D1 table creation |
| `GET` | `/migrate` | Migrate tables to TEXT chat_id |
| `GET` | `/` | Health check + `?command=set` webhook |
| `POST` | `/debug/smoke` | Insert a test job due now (needs `x-admin` header) |
| `POST` | `/debug/jobs` | List all jobs table rows (needs `x-admin`) |
| `POST` | `/debug/run` | Process due reminders + jobs inline — same code as the cron (needs `x-admin`) |
| `POST` | `/debug/jobs-clean` | Delete all jobs rows (needs `x-admin`) |
| `POST` | `/debug/kg` | Dump knowledge-graph triples (needs `x-admin`) |
| `POST` | `/internal/continue` | Split-and-continue resume pass — auth: `X-Continue` = SHA-256 hex of bot token; ACKs 202, pass runs in its own `waitUntil` (fresh 30s budget) |
| `POST` | `/debug/continuations` | List split-and-continue checkpoint rows (needs `x-admin`) |

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
# Auto: GitHub Actions (4x daily)
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
| `GROQ_API_KEY` | ✅ Yes | `ai.ts` | Chat fallback (llama-3.3) + voice (Whisper) |
| `TAVILY_API_KEY` | ✅ Yes | Bot, crew, workflow | Web search tool |
| `GITHUB_PAT` | ✅ Yes | `index.ts` | GitHub Actions dispatch |
| `GITHUB_REPO` | ✅ Yes | `index.ts` | e.g. `Thirupathi-pirate/ivy` |
| `UNSPLASH_ACCESS_KEY` | ✅ Yes | `publish_post.py`, workflow | Blog cover images |
| `CURRENTS_API_KEY` | ✅ Yes | `find_trending_topic.py`, workflow | Trending topics (replaces News API) | #WN
| `TELEGRAM_CHAT_ID` | ✅ Yes | workflow | Notification recipient |
| `CLOUDFLARE_API_TOKEN` | ✅ Yes | `repair-posts.yml`, `rebuild-deploy.yml` | Cache purge on deploy |
| `ADMIN_PASSWORD` | ❌ Optional | `index.ts` | Admin + `/debug/*` API access (`x-admin` header) |
| `IVY_PERSONA` | ❌ Optional | `ai.ts`, `index.ts` | Bot persona override (secret — `wrangler secret put IVY_PERSONA`) |
| `TMDB_API_KEY` | ❌ Optional | `ai.ts` | Enhanced movie tools |
| `REDDIT_CLIENT_ID` | ❌ Optional | `ai.ts` | Reddit search |
| `REDDIT_CLIENT_SECRET` | ❌ Optional | `ai.ts` | Reddit search |
| `REDDIT_USER_AGENT` | ❌ Optional | `ai.ts` | Reddit search |
| `TELEGRAM_API_ROOT` | ❌ Optional | `index.ts` | Override Bot API base URL (local testing only) |

> ⚠️ `.env` is **gitignored** (local dev only). Production secrets go via `wrangler secret put <NAME>` — never paste a key into a chat or commit it.

---

## ⚡ Model Chain

### Bot — Gemini primary, Groq fallback (11-model chain)
```
gemini-2.5-flash-lite         (preferred — fast/cheap, biggest free quota)
  → gemini-2.5-flash           (fallback 1)
  → gemini-3.1-flash-lite      (fallback 2)
  → gemini-3.5-flash-lite      (fallback 3)
  → gemini-3.5-flash           (fallback 4)
  → gemini-3.6-flash           (fallback 5 — slow on free tier, often hands off)
  → gemini-2.5-pro             (fallback 6 — slow on free tier, often hands off)
  → openai/gpt-oss-120b        (Groq — fallback 7, best Groq quality)
  → llama-3.3-70b-versatile    (Groq — fallback 8, proven workhorse)
  → openai/gpt-oss-20b         (Groq — fallback 9)
  → llama-3.1-8b-instant       (Groq — fallback 10, fastest/cheapest last resort)
```
- **Provider routing:** models starting with `gemini-` use `GEMINI_API_KEY` + `callGemini`; all others use `GROQ_API_KEY` + `callGroq` (OpenAI-compatible, tool support via `tool_choice: "auto"`).
- **Per-model free-tier quota:** Gemini free tier caps each model's requests per day per project (e.g. `gemini-2.5-flash` ≈ 20/day). More models in the chain = more daily buckets = more total capacity before hitting Groq.
- **Groq free tier:** 30 RPM per model; llama-3.3-70b 1K RPD / 12K TPM / **100K TPD**, gpt-oss-* 1K RPD / 8K TPM, llama-3.1-8b 14.4K RPD / 6K TPM. TPD is the binding constraint — each request charges input + reserved `max_tokens` against the daily bucket. 429s fall through silently to the next model (429 body is logged with the bucket numbers).
- **Groq output cap:** 8192 max tokens for all Groq models (`MODEL_MAX_TOKENS`). Long replies (movie breakdowns, multi-section answers) need the headroom; the cost is that Groq free TPD (llama-3.3 = 100K) charges input + reserved `max_tokens`, so one request burns ~10K — ~10 messages/day before the bucket dies and the chain falls through to Gemini. Tradeoff accepted: a cut-off reply is worse than burning the bucket faster.
- **Selectable** via `/models`, `/model <name>` (single source of truth: `MODELS` exported from `src/ai.ts`).
**Rate limiting:** Detects 429, 503, Gemini error codes. If all 11 models exhausted → *"I'm rate-limited across all models"*.
**Provider timeouts:** 8s fast-fail per model call (`MODEL_CALL_TIMEOUT_MS`). The webhook ACKs Telegram instantly and runs the AI loop in `ctx.waitUntil()`, which extends execution up to 30s after the response — the free-plan platform otherwise terminates webhook requests at ~10s wall-clock, which killed multi-turn tool flows (side effects ran, reply lost). The 8s fast-fail keeps slow models (3.6-flash / 2.5-pro on free tier) from monopolizing the 30s budget: each handoff burns ≤8s, so a 2-3 turn tool loop fits comfortably.

### Blog Writer (CrewAI) — Gemini only
```
Model: gemini/gemma-4-31b-it   (Gemini provider — crew never uses Groq)
Max tokens: 16384
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

-- Self-service cron jobs (recurring reminders + keyword alerts + page watches)
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  type TEXT NOT NULL,             -- daily / weekly / hourly / keyword / pagewatch
  schedule TEXT NOT NULL,
  message TEXT,
  keyword TEXT,
  next_run INTEGER NOT NULL,      -- epoch ms
  last_run INTEGER,
  last_result TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_jobs_next_run ON jobs(next_run);
CREATE INDEX idx_jobs_chat ON jobs(chat_id);

-- Knowledge graph (subject → predicate → object per user)
CREATE TABLE knowledge (
  chat_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  source TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, subject, predicate, object)
);
CREATE INDEX idx_knowledge_subject ON knowledge(chat_id, subject);

-- Cross-isolate webhook dedup (INSERT OR IGNORE on every update)
CREATE TABLE dedup (
  update_id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Split-and-continue checkpoints (requests that exceed the waitUntil budget)
CREATE TABLE continuations (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  data TEXT NOT NULL,               -- JSON: { messages: ChatMessage[], model: string }
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_continuations_created_at ON continuations(created_at);
```

**Split-and-continue:** when the tool loop hits the deadline (`AI_DEADLINE_MS = 22s`), the gathered state is checkpointed to `continuations` and the reply becomes `__CONTINUE__:<id>`. The webhook then fires `POST /internal/continue` through the **`SELF` service binding** (a plain `fetch()` to the worker's own workers.dev URL is NOT routed back and silently stalls — free-tier isolate deadlock), which resumes with a fresh 30s budget and either finishes (conclusion message) or saves a new checkpoint and chains again (`MAX_CONTINUE_PASSES = 4`). The cron sweep resumes orphaned checkpoints (>5 min old, attempts < 4) inline via `ctx.waitUntil` as a safety net.

**History cap:** system prompt + 9 most recent user/assistant turns.

---

## 🛠️ Tool Definitions

Ivy's tool loop uses GOAP-style detection — `needsTools()` checks messages for trigger keywords before attaching tool definitions, saving tokens on simple queries.

### 🧠 Memory
| Tool | Description |
|------|-------------|
| `memory_save(key, value)` | Save a fact/preference to D1 (upserts) |
| `memory_recall(key?)` | Recall saved facts — specific key or all |

> **Proactive autosave:** even when the model never calls `memory_save`, a separate
> extraction pass runs after every substantive reply and persists durable user
> facts directly (memories + knowledge graph triples with `source='autosave'`).
> `autosaveFacts(env, chatId, userText, aiElapsedMs)` in `src/ai.ts`:
> - **Budget guard:** skipped when the AI loop consumed >20s (`[AUTOSAVE] skipped (AI loop took …)`).
> - **Extraction:** tries the first 5 models of `FALLBACK_CHAIN` (wider net — per-model free-tier
>   quotas exhaust unevenly, e.g. flash-lite/flash/3.1 dead while 3.5-flash-lite still has quota),
>   `AUTOSAVE_PROMPT` demands pure JSON (`{"memories":[{"key","value"}],"knowledge":[{"subject","predicate","object"}]}`),
>   `parseAutosaveJson` tolerates markdown fences/broken JSON.
> - **Guardrails:** never saves world facts, conversation subject matter, prices, weather, or
>   anything transient; ignores instructions embedded in the user message.
> - **Hooks:** end of `handleChat` (text path), photo-caption path, and the split-and-continue
>   pass (fresh budget). PDF/document flows pass `{ autosave: false }` (external content).
>   All hooks **await** the pass so it stays inside the webhook's `waitUntil` chain — a
>   fire-and-forget promise there is abandoned when the event completes before its I/O resolves
>   (verified locally: zero saves across 3 runs until awaited).

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
| `fetch_url(url)` | Fetch URL content (first ~15K chars, 8s timeout, content-type check) |
| `browse_url(url, selector?)` | Browser Run Puppeteer: JS-rendered page text (SPAs, dashboards), optional CSS selector. Graceful "not enabled" without the binding |
| `screenshot_url(url)` | Browser Run Puppeteer: screenshot → `sendPhoto` to chat (fire-and-forget). Graceful "not enabled" without the binding |

> **Browser automation (Cloudflare Browser Run, paid):** `browse_url`/`screenshot_url` run Puppeteer (`@cloudflare/puppeteer` 1.3.0) in a Worker via the `browser` binding (**currently ACTIVE** in `wrangler.toml`). Without the binding the tools reply "not enabled" and the model falls back to `fetch_url`. **Chromium only** — Camoufox/Firefox anti-detect forks are NOT supported (that needs a Python sidecar, e.g. `python -m camoufox server` + Playwright). Browser sessions reuse via `keep_alive: 600000`. Tool timeout is 12s (`BROWSER_TOOL_TIMEOUT_MS`) so a render can't eat the waitUntil budget.

### ⏱️ Jobs (self-service cron: recurring reminders + keyword alerts + page watches)
| Tool | Description |
|------|-------------|
| `create_job(type, schedule, message?, keyword?, url?)` | Daily/weekly/hourly reminders, keyword alerts, pagewatch change detection |
| `list_jobs()` | List active jobs with next run time |
| `cancel_job(job_id)` | Cancel by ID |

### 🌦️ Utilities
| Tool | Description |
|------|-------------|
| `get_current_time(timezone?)` | UTC or IANA timezone (e.g. `Asia/Kolkata`) |
| `get_weather(city)` | Weather for a city |
| `get_youtube_transcript(url)` | Summarize a YouTube video from its transcript |

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

### `.github/workflows/blog-writer.yml`

```yaml
on:
  schedule:
    - cron: "30 23 * * *"    # 5:00 AM IST → general
    - cron: "30 4 * * *"     # 10:00 AM IST → tech
    - cron: "30 9 * * *"     # 3:00 PM IST → general
    - cron: "30 14 * * *"    # 8:00 PM IST → tech
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

**Tech vs General:** IST hour 10 or 20 (UTC 04:30 / 14:30) → tech; IST 5 AM (UTC 23:30) and 3 PM (UTC 09:30) → general.

Also: `.github/workflows/repair-posts.yml` — every 6h, runs `scripts/repair_posts.py` to fix LLM-leak / truncation issues in `_posts/`, then rebuilds + redeploys + purges Cloudflare cache. Only fires when posts actually changed (idempotent; cosmetic newline diffs are skipped).

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
| **`.env`** | Gitignored (local dev only) — production secrets via `wrangler secret put` |
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

# Browser automation (Cloudflare Browser Run, PAID usage-based)
[browser]
binding = "BROWSER"

# Self service binding — the ONLY reliable re-entry into this worker (split-and-continue).
# A plain fetch() to our own workers.dev route is NOT routed back and silently stalls.
[[services]]
binding = "SELF"
service = "ivy-blog-bot"

[triggers]
crons = ["* * * * *"]

[vars]
WORKER_URL = "https://ivy-blog-bot.priyamolmpraveen2.workers.dev"

```

> KV is declared but **not actively used**. D1 is the primary store: sessions, memories, reminders, jobs, knowledge graph, dedup, and continuations. The `SELF` service binding re-enters the worker for split-and-continue passes (fallback to `WORKER_URL` only if the binding is absent).

---

## 📌 Key Constraints

| Constraint | Detail |
|-----------|--------|
| **Blog posts** | ≥2500 words, 8 sections + intro + conclusion, emoji headers, Mermaid, blockquotes, source links |
| **Bot persona** | Ivy — warm, friendly AI assistant. Identity/tone configurable via `IVY_PERSONA` secret |
| **Session history** | D1 via `d1SessionAdapter()`, last ~10 messages (system + 9 recent) |
| **Long-term memory** | `memories` (key-value) + `knowledge` (subject→predicate→object triples, `source` = `memory_save`/tool or `autosave`) — injected into the system prompt on every turn |
| **Autosave** | After each reply, an awaited extraction pass persists durable facts (budget-guarded, first 5 fallback models, JSON-only output); see **Memory** tools section |
| **Reminders** | D1-backed, `* * * * *` cron |
| **Tool loop** | Max 5 turns per message |
| **Message dedup** | `dedup` D1 table (`INSERT OR IGNORE`, atomic cross-isolate) + in-memory Map fast path; rows pruned hourly by cron |
| **Tests** | `tests/` dir exists but empty |
