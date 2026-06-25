import os
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI

from nanobot import Nanobot

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("bridge")

TELEGRAM_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
ALLOWED_CHAT_ID = int(os.environ.get("ALLOWED_CHAT_ID", "5491880232"))

bot: Nanobot | None = None
http: httpx.AsyncClient | None = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global bot, http
    config_path = os.environ.get("NANOBOT_CONFIG", "nanobot-config.json")
    bot = Nanobot.from_config(config_path=config_path)
    http = httpx.AsyncClient(timeout=30)
    logger.info("bridge started with nanobot SDK")
    yield
    await bot.aclose()
    if http:
        await http.aclose()
    logger.info("bridge stopped")

app = FastAPI(lifespan=lifespan)

@app.post("/")
async def handle_update(update: dict):
    msg = update.get("message")
    if not msg or not msg.get("text"):
        return {"ok": True}

    chat_id = msg["chat"]["id"]
    if chat_id != ALLOWED_CHAT_ID:
        logger.warning("ignored chat %s", chat_id)
        return {"ok": True}

    text = msg["text"].strip()
    if not text:
        return {"ok": True}

    logger.info("chat %s: %s", chat_id, text[:80])

    try:
        result = await bot.run(text, session_key=f"tg:{chat_id}")
        reply = result.content
    except Exception as e:
        logger.exception("bot.run failed")
        reply = f"Sorry, I hit an error: {e}"

    telegram_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    if http:
        await http.post(telegram_url, json={
            "chat_id": chat_id,
            "text": reply,
            "parse_mode": "Markdown",
        })

    return {"ok": True}

@app.get("/health")
async def health():
    return {"status": "ok"}
