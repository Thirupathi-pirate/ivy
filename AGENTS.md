# AGENTS.md — Ivy Blog Bot

Two-layer project: **Telegram bot** (TypeScript, Cloudflare Worker) + **blog writer** (Python, CrewAI) + **blog host** (Jekyll/Chirpy, GitHub Pages).

---

## Architecture

```
Telegram → Cloudflare Worker (Hono + grammY) → Gemini API (chat, tool loop)
                                                  → D1 (sessions, memories, reminders)
                                                  → GitHub Actions dispatch (/write)
                                                     → CrewAI pipeline → Jekyll build → gh-pages
```

**Data flow:**
1. Telegram webhook POSTs to Worker → dedup by `update_id` (in-memory map, 10s TTL)
2. Session loaded from D1 (`sessions` table via `d1SessionAdapter`)
3. Memories loaded from D1 (`memories` table) → injected into system prompt
4. Gemini API called with message + tool definitions → tool loop (up to 5 turns)
5. Tool results appended to conversation → final response sanitized (Telegram Markdown) → sent back
6. `/write <topic>` → GitHub Actions dispatch → CrewAI pipeline → Jekyll build → gh-pages

## Entrypoints

| Layer | File |
|-------|------|
| Telegram bot (Worker) | `src/index.ts` — Hono app, grammY bot, webhook handler |
| AI orchestration | `src/ai.ts` — Gemini calls, tool loop, model fallback chain |
| Blog writer (CrewAI) | `src/blog_writing_crew/main.py` — `run()`, `train()`, `replay()`, `test()` |
| Post publisher | `scripts/publish_post.py` — frontmatter + Unsplash cover → Jekyll post |
| Trending topic finder | `scripts/find_trending_topic.py` — News API + Tavily → picks topic for automated runs |
| Blog source | `blog-source/` — Jekyll site, Chirpy theme, `_posts/` |
| CI/CD pipeline | `.github/workflows/daily-telegram.yml` — 3x daily (5:50 AM tech, 10 AM + 5:30 PM general) |

## Hono Routes

| Method | Path | Handler |
|--------|------|---------|
| `POST` | `/` | Telegram webhook — parses update, creates grammY Bot, calls `webhookCallback` |
| `POST` | `/admin/posts` | List blog posts from GitHub (requires `ADMIN_PASSWORD`) |
| `POST` | `/admin/delete` | Delete a post from GitHub + trigger rebuild (requires `ADMIN_PASSWORD`) |
| `POST` | `/discord` | Discord interactions endpoint (Ed25519 verify → PONG → deferred slash commands) |
| `POST` | `/register-commands` | Bulk-register Discord slash commands |
| `POST` | `/chat-message` | Relay endpoint for Discord Gateway @mention relay (auth'd via `DISCORD_RELAY_SECRET`) |
| `GET` | `/init` | One-time D1 table creation |
| `GET` | `/migrate` | Migrate tables to TEXT chat_id |
| `GET` | `/` | Health check + `?command=set` to register Telegram webhook |

## Commands

### Bot (TypeScript / Cloudflare Worker)
```bash
npm run dev          # wrangler dev (local)
npm run deploy       # wrangler deploy
npm run typecheck    # tsc --noEmit
node_modules/.bin/wrangler deploy   # if `npm run` fails
```

### Blog Writer (Python / CrewAI)
```bash
uv sync                # install deps
uv run crewai run      # run crew (writes output/blog_post.md)
uv run python scripts/publish_post.py "<topic>"   # manual publish
crewai test -n 2 -m gpt-4o-mini   # test crew
```

### Full Pipeline (GitHub Actions)
- Trigger: scheduled 3x daily (5:50 AM tech, 10 AM + 5:30 PM general) or `/write <topic>` on Telegram
- Steps: `uv sync → find_trending_topic.py → crewai run → publish_post.py → git commit → jekyll build → deploy gh-pages → Telegram notification`

## Environment Variables

| Var | Used In | Notes |
|-----|---------|-------|
| `TELEGRAM_BOT_TOKEN` | Bot, workflow | Bot auth |
| `GROQ_API_KEY` | `src/ai.ts` | Voice transcription (Whisper) |
| `TAVILY_API_KEY` | Bot + crew + workflow | Web search tool |
| `GEMINI_API_KEY` | `src/ai.ts` + `crew.py` + workflow | Bot LLM + Crew LLM (`google/gemma-4-31b-it`) |
| `UNSPLASH_ACCESS_KEY` | `publish_post.py` + workflow | Cover images |
| `GITHUB_PAT` | `src/index.ts` | PAT to dispatch workflow |
| `GITHUB_REPO` | `src/index.ts` | e.g. `Thirupathi-pirate/ivy` |
| `TELEGRAM_CHAT_ID` | workflow | Notification recipient |
| `NEWS_API_KEY` | `scripts/find_trending_topic.py` + workflow | Trending topics |
| `ADMIN_PASSWORD` | `src/index.ts` | Admin API access |
| `TMDB_API_KEY` | `src/ai.ts` | Movie tool (optional) |
| `REDDIT_CLIENT_ID` | `src/ai.ts` | Reddit search tool (optional) |
| `REDDIT_CLIENT_SECRET` | `src/ai.ts` | Reddit search tool (optional) |
| `REDDIT_USER_AGENT` | `src/ai.ts` | Reddit search tool (optional) |

⚠️ `.env` is **committed** to git with live keys (`.gitignore` was added late). Do not add new secrets to `.env` without user confirmation.

## Model Chain

### Bot (Gemini) — 3-model fallback on HTTP 429
```
gemini-2.5-flash-lite              (preferred, 30 RPM / 1,500 RPD / 1M TPM)
  → gemini-2.5-flash               (fallback 1)
  → gemini-3.1-flash-lite          (fallback 2)
```
Rate-limit detection: parses `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests` from 429 responses. Also catches 503 and Gemini-specific error codes. If all 3 models are exhausted, returns *"I'm rate-limited across all models"*.

### Blog Writer (CrewAI)
`google/gemma-4-31b-it` via Google Gemini API. 32768 max tokens, 300s timeout. Retry logic: 3 attempts with exponential backoff (30s, 60s, 120s) on 5xx / timeout / connection errors.

## D1 Schema

Three tables:

```sql
-- Sessions (grammY session adapter — custom d1SessionAdapter)
CREATE TABLE sessions (
  chat_id TEXT PRIMARY KEY,
  data TEXT NOT NULL          -- JSON: { history: ChatMessage[], model: string }
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
  timestamp INTEGER NOT NULL, -- epoch ms
  message TEXT NOT NULL
);
CREATE INDEX idx_reminders_timestamp ON reminders(timestamp);
```

Session history is capped at 10 messages: system prompt + 9 most recent user/assistant turns.

## Tool Definitions (Ivy's Tool Loop)

The AI has access to these functions. Tool detection is GOAP-style: the `needsTools()` function checks user messages for trigger keywords before attaching tool definitions, saving tokens on simple queries.

### Memory
- **`memory_save(key, value)`** — Save a fact/preference to D1. Upserts on conflict.
- **`memory_recall(key?)`** — Recall saved facts. With key: returns specific value. Without: lists all.

### Reminders
- **`create_reminder(time, message)`** — Schedule a reminder. `time` in HH:MM (24h) or ISO date string. Returns reminder ID + Unix timestamp.
- **`list_reminders()`** — List all active reminders with relative time display.
- **`cancel_reminder(reminder_id)`** — Cancel by ID. Returns success/not_found.

### Web
- **`search_web(query)`** — Tavily search with `include_answer: true`, returns summary + up to 5 results with content snippets.
- **`fetch_url(url)`** — Fetch a URL's content (first 8000 chars). Used for reading articles, docs, APIs.

### Time
- **`get_current_time(timezone?)`** — Current time in UTC or specified IANA timezone (e.g. `Asia/Kolkata`).

### Movies (3-source fallback chain: TMDB → Reddit → Tavily)
- **`get_movie_info(title, year?)`** — TMDB search → Reddit discussions (r/movies, r/moviecritic, r/TrueFilm) → Tavily. Returns rating, year, genres, overview + Reddit community posts.
- **`get_movie_recommendations(title)`** — TMDB recommendations → Reddit suggestions (r/MovieSuggestions, r/ifyoulikeblank) → Tavily.
- **`discover_movies(genres?, min_rating?, year?)`** — TMDB discover (vote_average desc, min 100 votes) → Reddit search → Tavily.

## Reminder System

- Cron `* * * * *` runs `scheduled()` every minute
- Queries `reminders WHERE timestamp <= now`
- Sends each due reminder via Telegram `sendMessage` with Markdown
- Deletes from D1 on successful send
- Hour/minute parsing: HH:MM sets today at that UTC time, or tomorrow if already past
- Full ISO date strings also accepted
- Reminder IDs: 8-char random UUID prefix

## Image / Voice / File Handling

### Photos
- Gets largest photo from Telegram file API
- Converts to base64 data URI → sends to Gemini as inline image
- Streams response back with simulated reveal (500-char steps)
- Strips image data from stored history to save KV quota

### Voice
- Downloads OGG via Telegram API
- Transcribes with Groq Whisper (`whisper-large-v3-turbo`)
- Feeds transcript back into chat flow

### Documents
- **PDF**: Parses raw bytes with TextDecoder, extracts metadata (`/Info` dict) and text operations (`Tj`, `TJ`, `'`, `"`). Detects uncompressed vs. scanned. Decodes PDF escape sequences (octal, `\n`, `\r`, `\t`). Returns first 10K chars.
- **Text files**: Downloads, reads as UTF-8, truncates at 10K chars. Supported: `.txt .csv .json .xml .md .html .log .yaml .toml .py .js .ts .rs .go .java .c .cpp .h .sql .rb .php .sh` and more.

### LaTeX Rendering
`$$...$$` or `\[...\]` in user messages → POST to QuickLaTeX → fetches PNG → sends as photo via `sendPhoto`. Fire-and-forget (error-tolerant).

### Mermaid Rendering
```` ```mermaid `` → base64url encodes diagram → fetches `mermaid.ink/img/` PNG → sends as photo via `sendPhoto`. Fire-and-forget.

## CrewAI Pipeline

Three agents in sequence:

### Writer
- Tools: `news_search` (Tavily), `wikipedia_search`, `hackernews_search` (Algolia), `arxiv_search`, `openlibrary_search`, `rss_feed` (feedparser)
- Researches topic across all sources, collects verifiable facts, statistics, real user quotes, academic papers
- Writes ≥2500 word blog post with 8 sections, emoji headers, Mermaid diagrams, blockquotes, bullet lists, inline source links
- Self-verifies every claim has a source URL

### Humaniser
- Rewrites to natural conversational tone (no AI jargon, no corporate language)
- Preserves all facts, source attributions, visual formatting
- Removes unsourced/unverifiable claims entirely (no `[UNVERIFIED]` markers)

### Editor
- Grammar/spelling/formatting polish
- Fact-checks every claim against provided sources
- Removes or rephrases unsupported statements
- Ensures publication-ready output with clean markdown

### Retry Logic
```python
for attempt in 1..3:
    try: crew.kickoff()
    except (5xx, timeout, connection error): wait(2^attempt * 30s)
    else: break
```

## Blog Host (`blog-source/`)

Jekyll site using **Chirpy 7.5** with a custom **Midnight Purple** theme.

### Key Files
| Path | Purpose |
|------|---------|
| `_sass/custom/custom.scss` | Midnight Purple theme (bg `#12121E`, accent `#BB86FC`) |
| `_includes/custom/head.html` | Mermaid dark-theme, OG tags, JSON-LD schema, favicon, canonical |
| `_includes/custom/tail.html` | Unsplash download-tracking JS |
| `_includes/custom/post.html` | Related posts section at end of each article |
| `_includes/breadcrumb.html` | Breadcrumb navigation with JSON-LD support |
| `_includes/footer.html` | Custom footer with GitHub link |
| `_tabs/about.md` | About page |
| `404.html` | Custom 404 with theme styling |
| `robots.txt` | Search engine crawl rules |
| `sitemap.xml` | Auto-generated by `jekyll-sitemap` |

### Mermaid
- Dark theme via `window.mermaid` in `head.html` (theme: `base`, purple accents)
- SCSS overrides container + SVG child elements (purple strokes/edges, font)
- Frontmatter `mermaid: true` required

### SEO
- `jekyll-sitemap` auto-generates `sitemap.xml`
- `jekyll-last-modified-at` adds `lastmod` to sitemap entries
- `robots.txt` points to sitemap, allows all
- `head.html`: canonical URL, meta description, OG tags, Twitter cards, JSON-LD `BlogPosting` schema
- Google Search Console verification placeholder in `head.html`
- Page title: **Ivy**, tagline: "Daily thoughts on tech, science & culture"
- JSON-LD: WebSite (knowledge panel + search action) + BlogPosting (dates, author, publisher, image, keywords)
- Breadcrumb JSON-LD + `article:section` for category context
- Preconnect/dns-prefetch for Google Fonts and Unsplash
- `theme-color` meta for mobile browser UI (#12121E)
- No AI references in site metadata — reads as a human editorial blog

### Performance
- Fonts via `<link>` in `head.html` (not CSS `@import`) — fetch starts during HTML parsing
- Preload: Inter + Spectral with `as="style"`
- Non-blocking: Playfair Display uses `media="print" onload="this.media='all'"`
- CLS prevention: avatar `aspect-ratio: 1`, inline images have explicit `width`/`height`
- Lazy loading: inline images `loading="lazy"` + `data-unsplash-dl` for download tracking
- Preconnect: early connection to Google Fonts and Unsplash origins

### Publishing Pipeline (`scripts/publish_post.py`)
- Reads crew output from `output/blog_post.md`
- Fetches 2 Unsplash images: 1st as cover (frontmatter), 2nd inline after intro
- Detects `mermaid` code blocks → sets `mermaid: true` in frontmatter
- Detects LaTeX patterns (`$$`, `\[`, `\text`, `\sum`, Greek letters, etc.) → sets `math: true`
- Writes to `blog-source/_posts/YYYY-MM-DD-slug.md`
- Gracefully falls back to 0-1 images if Unsplash fails

### UX Features
- **Page fade-in**: opacity + slide-up animation on load
- **Breadcrumbs**: schema-backed navigation on posts
- **Related posts**: 3 most recent articles at end of each post
- **Reading progress**: gradient purple progress bar at top of page
- **Share buttons**: Twitter, LinkedIn, Telegram
- **Smooth scroll**: `scroll-behavior: smooth` on `<html>`

### Avatar & Favicon
- Source: `/logo.png` (233×196, center-cropped to square)
- Avatar: `assets/avatar.webp` (192×192, circular in sidebar with purple border)
- Favicons: `assets/img/favicons/` (`.ico`, 16×16, 32×32, 96×96 PNG, apple-touch-icon 180×180)

## CI/CD Workflow (`.github/workflows/daily-telegram.yml`)

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

Steps:
1. `uv sync` — Install Python deps
2. `find_trending_topic.py --type tech|general` — Auto-discover topic (skipped if `topic` input provided)
3. `crewai run` — Write blog via CrewAI pipeline
4. `publish_post.py` — Add Unsplash images + Jekyll frontmatter
5. `git add` + `git commit` + `git push` — Commit to `main`
6. `jekyll build` — Build site
7. `gh-pages` deploy
8. `curl` Telegram `sendMessage` — Notify `TELEGRAM_CHAT_ID`

Tech vs general determination: UTC 00:20 = IST 5:50 AM → tech; UTC 04:30 = IST 10:00 AM → general; UTC 12:00 = IST 5:30 PM → general.

## Topic Finder (`scripts/find_trending_topic.py`)

- **`--type tech`**: News API `category=technology` + Tavily "trending technology news today" → filter by tech keyword set (200+ terms across AI, crypto, cloud, hardware, EV, gaming, programming, etc.)
- **`--type general`**: News API `category=general` + Tavily trending queries → exclude tech keywords
- Deduplicates by lowercase title (strips trailing `.?!`)
- Randomly picks from top 20 candidates
- Falls back to a default topic if no candidates found

## Style / Conventions

- **TypeScript**: strict mode, ES2022 target, `@cloudflare/workers-types`, `isolatedModules: true`
- **CrewAI**: `@CrewBase` decorator + YAML config pattern (`agents.yaml`, `tasks.yaml`)
- **Blog posts**: `_posts/YYYY-MM-DD-title.md` with standard Chirpy frontmatter
- **Git**: conventional commits. CI commits `[skip ci]`
- **`.env`**: committed to git — do not add new secrets without user confirmation
- **`cloudflare-worker.js`** is legacy — do not edit or deploy. Active worker is `src/index.ts` + `src/ai.ts`

## Wrangler Config

```toml
name = "ivy-blog-bot"
main = "src/index.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]
kv_namespaces = [{ binding = "IVY_KV", id = "9dfd92f4487a4c0aa6114b60b5c9127b" }]
d1_databases = [{ binding = "IVY_DB", database_name = "ivy-blog-bot", database_id = "9d3bfed4-e4af-446c-85aa-0011fcab103f" }]
triggers = { crons = ["* * * * *"] }
```

KV namespace is declared but not actively used for the Telegram session adapter (in-memory Map with 10s TTL used instead to save KV quota). D1 is the primary data store.

## Key Constraints

- **Blog posts**: ≥2500 words, 8 sections + intro + conclusion, emoji headers, Mermaid diagrams, blockquotes, inline source links, rich markdown — expensive in tokens
- **Bot persona**: Ivy — warm, female, friendly AI assistant
- **Session history**: D1-stored via custom `d1SessionAdapter()`, last ~10 messages (system + 9 recent)
- **Reminders**: D1-backed, fired by cron `* * * * *`
- **Tool loop**: max 5 turns per message to prevent runaway tool calls
- **Message dedup**: in-memory Map for Telegram `update_id`, 10s TTL, max 100 entries
- **No tests** — `tests/` dir exists but empty
