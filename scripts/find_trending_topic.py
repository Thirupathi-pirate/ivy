#!/usr/bin/env python
"""Find trending topics using Hacker News + News API + Tavily.

Tech: HN top stories (score-based) → News API tech → Tavily targeted
General: News API general (primary) → Tavily targeted (supplement)
"""

import argparse
import json
import os
import random
import sys
from pathlib import Path
from typing import List, Set, Tuple

import requests

USED_TOPICS_FILE = Path(__file__).parent / "used_topics.json"
MAX_USED = 200  # ponytail: cap to avoid unbounded growth

TECH_KEYWORDS: Set[str] = {
    "ai", "artificial intelligence", "machine learning", "llm", "gpt",
    "chatgpt", "openai", "google ai", "meta ai",
    "tech", "technology", "startup", "software", "programming",
    "crypto", "blockchain", "bitcoin", "nft", "web3",
    "smartphone", "iphone", "android", "ios",
    "cybersecurity", "hack", "ransomware", "data breach",
    "cloud", "saas", "data center",
    "robot", "automation", "chip", "semiconductor",
    "quantum", "neural", "deep learning", "data science",
    "app", "api", "database",
    "devops", "kubernetes", "docker",
    "computer", "laptop", "gadget", "wearable",
    "electric vehicle", "ev", "tesla",
    "spacex", "nasa",
    "internet", "broadband", "5g", "6g",
    "streaming", "netflix", "youtube",
    "gaming", "playstation", "xbox", "nintendo",
    "vr", "ar", "virtual reality", "augmented reality",
    "nvidia", "intel", "amd",
    "apple", "samsung", "google", "microsoft", "amazon",
    "meta", "twitter", "x corp",
    "algorithm", "big data", "analytics",
    "defi",
    "github", "open source",
    "chatbot", "copilot",
    "cyber",
    "autonomous", "self-driving",
    "drone", "robotics",
    "renewable", "solar", "wind energy",
    "battery", "lithium",
    "satellite",
    "javascript", "python", "rust", "typescript",
    "react", "nextjs", "angular", "vue",
    "aws", "azure", "gcp",
    "serverless", "microservice",
    "metaverse",
    "iot",
    "windows", "linux", "macos",
    "gpu", "cpu",
    "wifi", "bluetooth", "nfc",
    "container",
    "sdk", "cli", "ide",
    "vulnerability", "patch", "update",
    "blockchain",
}

# Generic topics to skip — waste of tokens
SKIP_PATTERNS: Set[str] = {
    "daily life", "culture around the world", "technology trends shaping",
    "latest news", "breaking news", "what's happening",
    "daily roundup", "weekly roundup", "morning briefing",
    "today's top", "today's biggest", "in case you missed",
    "things to know", "what to know",
}


def load_used_topics() -> Set[str]:
    """Load previously used topics from JSON file."""
    if USED_TOPICS_FILE.exists():
        try:
            with open(USED_TOPICS_FILE) as f:
                return set(json.load(f))
        except (json.JSONDecodeError, OSError):
            pass
    return set()


def save_used_topic(topic: str) -> None:
    """Append a topic to the used list, capping at MAX_USED."""
    used = load_used_topics()
    used.add(topic)
    used_list = list(used)[-MAX_USED:]
    USED_TOPICS_FILE.write_text(json.dumps(used_list, indent=2))


def is_generic(title: str) -> bool:
    """Check if a title is too generic to be worth writing about."""
    lower = title.lower()
    return any(pat in lower for pat in SKIP_PATTERNS)


def is_tech(title: str) -> bool:
    return any(kw.lower() in title.lower() for kw in TECH_KEYWORDS)


def deduplicate(titles: List[str]) -> List[str]:
    seen: Set[str] = set()
    result = []
    for t in titles:
        key = t.lower().strip().rstrip(".!?")
        if key not in seen:
            seen.add(key)
            result.append(t)
    return result


# ── Hacker News (free, no API key) ──────────────────────────────────

def fetch_hacker_news(limit: int = 30) -> List[Tuple[str, int]]:
    """Fetch top HN stories as (title, score) sorted by score desc."""
    try:
        resp = requests.get(
            "https://hacker-news.firebaseio.com/v0/topstories.json",
            timeout=10,
        )
        resp.raise_for_status()
        story_ids = resp.json()[:limit]
    except Exception as e:
        print(f"HN API error: {e}", file=sys.stderr)
        return []

    stories = []
    for sid in story_ids:
        try:
            r = requests.get(
                f"https://hacker-news.firebaseio.com/v0/item/{sid}.json",
                timeout=5,
            )
            r.raise_for_status()
            item = r.json()
            if item and item.get("title"):
                stories.append((item["title"], item.get("score", 0)))
        except Exception:
            continue
    return sorted(stories, key=lambda x: x[1], reverse=True)


# ── News API ────────────────────────────────────────────────────────

def fetch_news_api(api_key: str, category: str) -> List[str]:
    try:
        resp = requests.get(
            "https://newsapi.org/v2/top-headlines",
            params={"apiKey": api_key, "country": "us", "pageSize": 20, "category": category},
            timeout=10,
        )
        resp.raise_for_status()
        return [a["title"] for a in resp.json().get("articles", []) if a.get("title")]
    except Exception as e:
        print(f"News API error: {e}", file=sys.stderr)
        return []


# ── Tavily ─────────────────────────────────────────────────────────

def fetch_tavily(api_key: str, queries: List[str]) -> List[str]:
    results = []
    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=api_key)
        for q in queries:
            r = client.search(query=q, max_results=10, search_depth="basic")
            for res in r.get("results", []):
                if res.get("title"):
                    results.append(res["title"])
    except Exception as e:
        print(f"Tavily error: {e}", file=sys.stderr)
    return results


# ── Scoring ─────────────────────────────────────────────────────────

def score_topic(title: str, source_priority: int) -> float:
    """Score a topic: higher = better for blog writing.

    source_priority: 0=best (HN), 1=good (News API), 2=fallback (Tavily)
    """
    score = 100.0 - (source_priority * 30)  # HN: 100, News: 70, Tavily: 40

    lower = title.lower()

    # Bonus for high-signal patterns
    if any(w in lower for w in ["launch", "release", "announce", "unveil"]):
        score += 20
    if any(w in lower for w in ["study", "research", "paper", "finds"]):
        score += 15
    if any(w in lower for w in ["billion", "million", "record", "first"]):
        score += 10
    if "?" in title:  # questions are engaging
        score += 5

    # Penalty for fluff
    if len(title) < 30:
        score -= 20
    if any(w in lower for w in ["opinion", "editorial", "column"]):
        score -= 15
    if is_generic(title):
        score -= 50

    return score


# ── Main ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Find a trending topic for blog writing")
    parser.add_argument("--type", choices=["tech", "general"], default="general")
    args = parser.parse_args()

    api_key = os.environ.get("NEWS_API_KEY", "")
    tavily_key = os.environ.get("TAVILY_API_KEY", "")
    used = load_used_topics()

    scored: List[Tuple[str, float]] = []

    if args.type == "tech":
        # 1. HN — highest signal for tech (score-based, free)
        print("Fetching Hacker News...", file=sys.stderr)
        hn_stories = fetch_hacker_news(30)
        for title, hn_score in hn_stories:
            if title not in used:
                scored.append((title, score_topic(title, 0) + min(hn_score / 10, 30)))

        # 2. News API tech
        if api_key:
            news = fetch_news_api(api_key, "technology")
            print(f"News API tech: {len(news)}", file=sys.stderr)
            for t in news:
                if t not in used:
                    scored.append((t, score_topic(t, 1)))

        # 3. Tavily — targeted tech queries
        if tavily_key:
            tech_queries = [
                "latest programming language release",
                "new AI model or tool launch",
                "cloud computing breaking news",
                "open source project trending",
                "cybersecurity vulnerability discovered",
            ]
            tav = fetch_tavily(tavily_key, tech_queries)
            print(f"Tavily tech: {len(tav)}", file=sys.stderr)
            for t in tav:
                if t not in used:
                    scored.append((t, score_topic(t, 2)))

    else:  # general
        # 1. News API general — primary source (Reddit blocks public JSON)
        if api_key:
            news = fetch_news_api(api_key, "general")
            print(f"News API general: {len(news)}", file=sys.stderr)
            for t in news:
                if t not in used:
                    scored.append((t, score_topic(t, 0)))  # primary = best priority

        # 2. Tavily — targeted general queries (supplement)
        if tavily_key:
            gen_queries = [
                "scientific discovery this week",
                "major business news today",
                "health breakthrough news",
                "climate change latest developments",
                "world events people are discussing",
            ]
            tav = fetch_tavily(tavily_key, gen_queries)
            print(f"Tavily general: {len(tav)}", file=sys.stderr)
            for t in tav:
                if t not in used:
                    scored.append((t, score_topic(t, 1)))  # supplement = good priority

    # Deduplicate
    seen_titles: Set[str] = set()
    unique_scored = []
    for title, score in scored:
        key = title.lower().strip().rstrip(".!?")
        if key not in seen_titles:
            seen_titles.add(key)
            unique_scored.append((title, score))

    # Filter out generic
    unique_scored = [(t, s) for t, s in unique_scored if not is_generic(t)]

    # Sort by score desc
    unique_scored.sort(key=lambda x: x[1], reverse=True)

    # Take top candidates
    top = unique_scored[:20]
    print(f"\nTop {len(top)} candidates:", file=sys.stderr)
    for i, (t, s) in enumerate(top[:5], 1):
        print(f"  {i}. [{s:.0f}] {t[:80]}", file=sys.stderr)

    if not top:
        fallback = "Latest breakthroughs in AI and technology" if args.type == "tech" else "World news and scientific discoveries"
        print(fallback)
        return

    # Weighted random from top 5 (not pure random)
    pool = top[:5]
    weights = [s for _, s in pool]
    topic = random.choices(pool, weights=weights, k=1)[0][0]

    print(f"\nSelected: {topic}", file=sys.stderr)
    print(topic)
    save_used_topic(topic)


if __name__ == "__main__":
    main()
