# Ivy — AI Blog Bot

Telegram bot that writes and publishes blog posts automatically. Powered by CrewAI for research-backed content, Jekyll/Chirpy for hosting, and a Cloudflare Worker for real-time chat.

## Features

- **Chat** — AI assistant (Ivy) with tool loop: web search, reminders, memory, URL fetching, movie discovery, image analysis, voice transcription, PDF reading
- **Auto blog writing** — 3x daily scheduled posts (tech at 5:50 AM IST, general at 10 AM + 5:30 PM IST) with dynamically discovered trending topics
- **Manual blog writing** — `/write <topic>` on Telegram triggers the full CrewAI pipeline
- **Trending topics** — Auto-sourced from News API, Tavily web search; no topic needed for scheduled runs
- **Long-term memory** — Ivy remembers facts about you across conversations (D1-backed)
- **Reminders** — Natural language reminder scheduling with cron-based delivery
- **Vision** — Describe images, transcribe voice messages, read PDFs
- **Movie discovery** — TMDB + Reddit + Tavily multi-source recommendations
- **Blog hosting** — Jekyll/Chirpy with Midnight Purple theme, SEO, Mermaid diagrams, LaTeX math, Unsplash cover images

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
- **5:50 AM IST** — Tech topic (auto-discovered)
- **10:00 AM IST** — General topic
- **5:30 PM IST** — General topic

Manual trigger: `/write <topic>` on Telegram dispatches the same workflow.

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
