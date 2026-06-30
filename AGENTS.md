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
| `GROQ_API_KEY` | `src/ai.ts` | Bot LLM |
| `TAVILY_API_KEY` | Bot + crew + workflow | Web search |
| `GEMINI_API_KEY` | `crew.py` + workflow | Crew LLM: `google/gemma-4-31b-it` |
| `UNSPLASH_ACCESS_KEY` | `publish_post.py` + workflow | Cover images |
| `GITHUB_PAT` | `src/index.ts` | PAT to dispatch workflow |
| `GITHUB_REPO` | `src/index.ts` | e.g. `Thirupathi-pirate/ivy` |
| `TELEGRAM_CHAT_ID` | workflow | Notification recipient |
| `NEWS_API_KEY` | `scripts/find_trending_topic.py` + workflow | Trending topics |
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
Rate-limit detection: parses `retry-after`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests` from 429 responses.

### Blog Writer (CrewAI)
`google/gemma-4-31b-it` via Google Gemini API.

## Key Constraints

- **Blog posts**: ≥2200 words, 6-8 sections, emoji headers, Mermaid diagrams, rich markdown — expensive in tokens
- **Bot persona**: Ivy — warm, female, friendly AI assistant
- **Reminders**: D1-backed, fired by cron `* * * * *`
- **Session history**: D1-stored via custom `d1SessionAdapter()`, last ~10 messages (system + 9 recent)
- **No tests** — `tests/` dir exists but empty
- **`cloudflare-worker.js` is legacy** — do not edit or deploy. Active worker is `src/index.ts` + `src/ai.ts`

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
- Dark theme configured via `window.mermaid` in `head.html` (theme: `base`, purple accents)
- SCSS overrides container + SVG child elements (purple strokes/edges, font)
- Frontmatter `mermaid: true` required

### SEO
- `jekyll-sitemap` gem auto-generates `sitemap.xml`
- `jekyll-last-modified-at` gem adds `lastmod` to sitemap entries
- `robots.txt` points to sitemap, allows all
- `head.html` includes: canonical URL, meta description, OG tags, Twitter cards, JSON-LD `BlogPosting` schema
- Google Search Console verification placeholder in `head.html`
- Page title in config: **Ivy**, tagline: "Daily thoughts on tech, science & culture"
- JSON-LD: WebSite (knowledge panel + search action) + BlogPosting (with dates, author, publisher, image, keywords)
- Breadcrumb JSON-LD + `article:section` for category context
- Preconnect/dns-prefetch for Google Fonts and Unsplash
- `theme-color` meta for mobile browser UI (#12121E)
- No AI references in site metadata — reads as a human editorial blog

### Performance
- **Fonts**: loaded via `<link>` in `head.html` (not CSS `@import`) — starts fetch during HTML parsing
- **Preload**: Inter + Spectral stylesheets preloaded with `as="style"`
- **Non-blocking**: Playfair Display uses `media="print" onload="this.media='all'"` (not critical for first paint)
- **CLS prevention**: avatar has `aspect-ratio: 1`; inline images have explicit `width`/`height`
- **Lazy loading**: inline images use `loading="lazy"` + `data-unsplash-dl` for download tracking
- **Preconnect**: early connection to Google Fonts and Unsplash origins

### Publishing Pipeline (`scripts/publish_post.py`)
- Reads crew output from `output/blog_post.md`
- Fetches **2 Unsplash images**: 1st as cover (frontmatter), 2nd inline after intro
- Detects `mermaid` code blocks → sets `mermaid: true` in frontmatter
- Writes to `blog-source/_posts/YYYY-MM-DD-slug.md`
- Gracefully falls back to 0-1 images if Unsplash fails

### UX Features
- **Page fade-in**: subtle opacity + slide-up animation on load
- **Breadcrumbs**: schema-backed navigation on posts
- **Related posts**: 3 most recent articles at end of each post
- **Reading progress**: gradient purple progress bar at top of page
- **Share buttons**: Twitter, LinkedIn, Telegram
- **Smooth scroll**: `scroll-behavior: smooth` on `<html>`

### Avatar & Favicon
- Source: `/logo.png` (233×196, center-cropped to square)
- Avatar: `assets/avatar.webp` (192×192, circular in sidebar with purple border)
- Favicons: `assets/img/favicons/` (`.ico`, 16×16, 32×32, 96×96 PNG, apple-touch-icon 180×180)

## Style / Conventions

- TypeScript: strict mode, ES2022 target, Workers types
- CrewAI: `@CrewBase` + YAML config pattern (`agents.yaml`, `tasks.yaml`)
- Blog posts: `_posts/YYYY-MM-DD-title.md` with standard Chirpy frontmatter
- Git: conventional commits. CI commits `[skip ci]`
