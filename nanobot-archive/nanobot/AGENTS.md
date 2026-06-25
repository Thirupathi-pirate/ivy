# AGENTS.md — Blog Writing Crew

## Project Overview

Daily blog writing system using **CrewAI** (v1.14.7) with 3 sequential agents.
Searches web news via Tavily → writes blog → humanises → edits → publishes to
Jekyll+Chirpy blog on GitHub Pages → notifies Telegram.

**Domain:** `blog.aaruvi.space`  |  **Repo:** `Thirupathi-pirate/ivy` (public)

## Architecture

```
Telegram webhook → Cloudflare Worker
  ├── /write <topic> → GitHub Actions workflow_dispatch
  └── other messages → nanobot on HidenCloud (chat bot via Groq)

GitHub Actions (daily cron 5:30 UTC + /write trigger)
  → uv run crewai run (CrewAI with Gemma 4 26B)
  → scripts/publish_post.py (Unsplash image + Jekyll frontmatter)
  → bundle exec jekyll build → gh-pages deploy
  → Telegram notification (appleboy/telegram-action)
```

## Key Commands

```bash
uv sync                         # Install dependencies (uv, not pip)
uv run crewai run               # Run crew (reads TOPIC from env)
TOPIC="AI news" uv run crewai run  # Run with custom topic
uv run python scripts/publish_post.py "Topic"  # Convert output → Jekyll post
uv add <package>                # Add dependency
```

## Environments & Secrets

Set in `.env` (not committed, read at runtime by CrewAI):
```
MODEL=google/gemma-4-26b-a4b-it
GEMINI_API_KEY=...
TAVILY_API_KEY=...
UNSPLASH_ACCESS_KEY=...
```

GitHub Actions secrets: `GEMINI_API_KEY`, `TAVILY_API_KEY`, `UNSPLASH_ACCESS_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

Cloudflare Worker secrets: `GITHUB_PAT`, `GITHUB_REPO`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `NANOBOT_URL`.

**Never commit `.env` or real secrets.**

## Crew Structure

`src/blog_writing_crew/config/` — YAML agent/task definitions.
`src/blog_writing_crew/crew.py` — `@CrewBase` class, method names must match YAML keys exactly.
`src/blog_writing_crew/tools/custom_tool.py` — `NewsSearchTool` (Tavily, advanced depth, score ≥ 0.8 filter).
`src/blog_writing_crew/main.py` — Entry point, reads `TOPIC` env var.

LLM: `google/gemma-4-26b-a4b-it` via `crewai.LLM` (set once in `crew.py:_llm`).

| Agent | Tool | Purpose |
|-------|------|---------|
| writer | NewsSearchTool | Research + write first draft (≥2200 words, emoji, mermaid, callouts) |
| humaniser | none | Rewrite in natural conversational tone, preserve all formatting |
| editor | none | Grammar, spelling, markdown polish, output → `output/blog_post.md` |

## CI / Publishing

`.github/workflows/daily-telegram.yml` — cron `30 5 * * *` UTC + `workflow_dispatch`.
Pipeline: checkout → install deps → run crew → publish post → build Jekyll → gh-pages deploy → Telegram notification.

`scripts/publish_post.py` — reads `output/blog_post.md`, fetches Unsplash image by topic,
builds frontmatter (`layout: post`, `toc: true`, mermaid detection, photographer attribution),
writes to `blog-source/_posts/YYYY-MM-DD-slug.md`.

## Telegram / Chat

`cloudflare-worker.js` — single webhook endpoint for Telegram bot.
- `/write <topic>` → POST to GitHub Actions dispatch API
- everything else → POST to `NANOBOT_URL` (nanobot on HidenCloud)

## Python SDK (nanobot on HidenCloud)

The chat bot uses nanobot's Python SDK: `Nanobot.from_config()` → `await bot.run(text)`.
Config at `~/.nanobot/config.json` — Groq provider (OpenAI-compatible), no Telegram channel
(since Worker owns the webhook).

## Conventions

- `# type: ignore[index]` on `self.agents_config[...]` / `self.tasks_config[...]` access
- YAML variable interpolation via `{topic}`, `{current_year}`
- `Process.sequential` — outputs flow through tasks in order
- `crew.run()` writes `output/blog_post.md` (last task's `output_file`)
- Blog posts use Chirpy theme: `layout: post`, `toc: true`, optional `mermaid: true`
