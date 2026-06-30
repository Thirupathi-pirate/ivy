# Ivy — AI Blog Bot

Telegram bot that writes and publishes blog posts automatically. Powered by CrewAI for research-backed content, Jekyll/Chirpy for hosting, and a Cloudflare Worker for real-time chat.

## Features

### AI Chat (Ivy)
Warm, friendly AI assistant with a tool loop for research, productivity, and entertainment. Ivy can search the web, remember facts across conversations, set reminders, fetch URLs, discover movies, analyze images, transcribe voice, and read PDFs. Runs on a 3-model Gemini fallback chain.

### Automated Blog Writing
3x daily scheduled posts via GitHub Actions — tech topic at 5:50 AM IST, general topics at 10 AM and 5:30 PM IST. Each run auto-discovers a trending topic, sends it through the CrewAI pipeline (research → writing → humanising → editing), fetches Unsplash cover images, publishes to the Jekyll blog, and notifies you on Telegram.

### Manual Blog Writing
`/write <topic>` dispatches the same CrewAI pipeline on demand. Perfect for timely content or specific topics you want covered.

### Trending Topic Discovery
No topic required for scheduled runs. The system queries News API and Tavily to find what's trending — tech keywords for the morning slot, general headlines for afternoon slots.

### Long-Term Memory
Ivy remembers facts, preferences, and personal details you share. Saved to D1, loaded automatically every conversation. Use `/forget` to clear everything.

### Smart Reminders
Natural language scheduling — "remind me at 14:30 to call mom" or "remind me tomorrow at 9am". D1-backed, delivered by the Worker's `* * * * *` cron. List and cancel reminders on demand.

### Image Analysis
Send any photo — Ivy describes objects, colors, composition, mood, and text visible. Powered by Gemini's vision capabilities.

### Voice Transcription
Send a voice message — transcribed via Groq Whisper, then Ivy processes the text as a normal chat message.

### Document Reading
Send PDFs or text files (TXT, CSV, JSON, code files, etc.). Ivy extracts and reads the content. PDFs are parsed for metadata and uncompressed text.

### Movie Discovery
Multi-source movie recommendations via TMDB (ratings, cast, similar titles), Reddit (real community discussions), and Tavily (Reddit-targeted web search). Ask for movies by genre, mood, or title.

### LaTeX & Mermaid Rendering
Inline `$$...$$` formulas render as images via QuickLaTeX. ` ```mermaid ` code blocks render as PNG via mermaid.ink. The blog theme also supports MathJax and native Mermaid.

## Architecture

```
Telegram → Cloudflare Worker (Hono + grammY) → Gemini API (chat, tool loop)
                                                  → D1 (sessions, memories, reminders)
                                                  → GitHub Actions dispatch (/write)
                                                     → CrewAI pipeline → Jekyll build → gh-pages
```

## Quick Start

### Prerequisites
- Node.js 20+
- Python 3.10+
- [uv](https://docs.astral.sh/uv/) (`pip install uv`)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### 1. Clone & install
```bash
git clone https://github.com/Thirupathi-pirate/ivy.git
cd ivy
uv sync                    # Python deps (CrewAI blog writer)
npm install                # TypeScript deps (Cloudflare Worker)
```

### 2. Environment variables
Copy `.env.example` (or use the committed `.env`) and ensure these keys are set:

| Variable | Required | Used For |
|----------|----------|----------|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot auth |
| `GEMINI_API_KEY` | Yes | AI chat + crew LLM |
| `GROQ_API_KEY` | Yes | Voice transcription |
| `TAVILY_API_KEY` | Yes | Web search tool |
| `GITHUB_PAT` | Yes | GitHub Actions dispatch |
| `GITHUB_REPO` | Yes | e.g. `Thirupathi-pirate/ivy` |
| `UNSPLASH_ACCESS_KEY` | Yes | Blog cover images |
| `NEWS_API_KEY` | Yes | Trending topic discovery |

Optional: `TMDB_API_KEY`, `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`/`REDDIT_USER_AGENT` for enhanced movie tools.

### 3. Deploy the Worker
```bash
npm run deploy
```
Visit `https://your-worker.workers.dev/init` to create D1 tables.
Visit `https://your-worker.workers.dev/?command=set` to register the Telegram webhook.

## Usage

### Telegram
| Command | Action |
|---------|--------|
| `/start` | Welcome message |
| `/write <topic>` | Generate and publish a blog post |
| `/models` | Switch AI model (inline keyboard) |
| `/model <name>` | Set model by name |
| `/new` | Reset conversation |
| `/clear` | Clear chat history |
| `/redo` | Re-send last message |
| `/redo <text>` | Re-send with edited text |
| `/forget` | Clear memories + reset |
| `/system` | View status |
| `/help` | All commands |

Send photos, voice messages, PDFs, or text documents for analysis. In groups, mention `@IvyBot` or reply to Ivy's messages.

### Running the Blog Writer Locally
```bash
TOPIC="Your blog topic" uv run crewai run
uv run python scripts/publish_post.py "Your blog topic"
```

### Finding Trending Topics
```bash
uv run python scripts/find_trending_topic.py --type tech
uv run python scripts/find_trending_topic.py --type general
```

## Scheduled Publishing

The workflow runs 3x daily via GitHub Actions:
- **5:50 AM IST** — Tech topic (auto-discovered from News API + Tavily)
- **10:00 AM IST** — General topic
- **5:30 PM IST** — General topic

Manual trigger: `/write <topic>` on Telegram dispatches the same workflow.

Publishing steps: topic discovery → CrewAI pipeline (writer → humaniser → editor) → Unsplash cover fetch → Jekyll frontmatter → commit to `blog-source/_posts/` → Jekyll build → deploy to GitHub Pages → Telegram notification.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Bot runtime | Cloudflare Workers (Hono, grammY) |
| AI chat | Google Gemini API (3-model fallback chain) |
| Voice transcribe | Groq Whisper |
| Web search | Tavily API |
| Blog writing | CrewAI (3 agents: writer → humaniser → editor) |
| Blog host | Jekyll + Chirpy 7.5, GitHub Pages |
| Database | Cloudflare D1 (SQLite) |
| Trending topics | News API + Tavily |
| Images | Unsplash API |
| CI/CD | GitHub Actions |

## Project Structure

```
src/
  index.ts              — Hono app, bot handlers
  ai.ts                 — Gemini API, tool loop, memory, movie tools
  blog_writing_crew/    — CrewAI blog writer (agents, tasks, tools)
    crew.py             — Agent/task definitions
    main.py             — Entrypoints (run, train, replay, test)
    config/
      agents.yaml       — Agent roles & backstories
      tasks.yaml        — Task descriptions & instructions
    tools/
      custom_tool.py    — Tavily, Wikipedia, HN, ArXiv, OpenLibrary, RSS
scripts/
  publish_post.py       — Unsplash cover + frontmatter → Jekyll post
  find_trending_topic.py — Trending topic discovery (News API + Tavily)
blog-source/            — Jekyll site (Chirpy theme, _posts/)
.github/workflows/      — CI/CD pipelines
```

## License

MIT
