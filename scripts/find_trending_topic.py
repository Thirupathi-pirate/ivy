#!/usr/bin/env python
"""Find topics worth writing about — relevant to people and tech enthusiasts.

Tech: HN stories people actually discuss → targeted Tavily queries
General: News API relevant stories → targeted Tavily queries
"""

import argparse
import json
import os
import random
import re
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

# Skip these — not worth a blog post
SKIP_PATTERNS: Set[str] = {
    # Generic fluff
    "daily life", "culture around the world", "technology trends shaping",
    "latest news", "breaking news", "what's happening",
    "daily roundup", "weekly roundup", "morning briefing",
    "today's top", "today's biggest", "in case you missed",
    "things to know", "what to know",
    # Academic/niche — not for general readers
    "fundamentals of", "introduction to", "survey of",
    "paper on", "thesis on",
    # Old stuff
    "(2005)", "(2006)", "(2007)", "(2008)", "(2009)",
    "(2010)", "(2011)", "(2012)", "(2013)", "(2014)",
    "(2015)", "(2016)", "(2017)", "(2018)", "(2019)",
    # Pure politics — divisive, not blog-worthy
    "election", "polls", "senate", "congress", "democrat", "republican",
    # Celebrity gossip — unless tech angle
    "celebrity", "gossip", "dating",
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


def is_skip(title: str) -> bool:
    """Check if a title should be skipped."""
    lower = title.lower()
    return any(pat in lower for pat in SKIP_PATTERNS)


def is_relevant_to_people(title: str) -> bool:
    """Check if this topic matters to everyday people or tech enthusiasts."""
    lower = title.lower()
    # Relevant signals — things people care about
    relevant_words = [
        # Tech people use
        "new", "update", "feature", "tool", "app", "free", "best",
        "how to", "guide", "tip", "trick", "hack",
        "vs", "compare", "review", "worth",
        # People care about
        "health", "money", "save", "cost", "price", "deal",
        "security", "privacy", "safe", "protect",
        "work", "job", "career", "remote",
        "home", "family", "life",
        "science", "discover", "study finds", "research shows",
        "environment", "climate", "future",
        # Tech enthusiasts care about
        "launch", "release", "announce", "unveil",
        "open source", "github", "developer",
        "startup", "funding", "billion",
        "ai", "gpt", "llm", "model",
    ]
    return any(w in lower for w in relevant_words)


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
    """Score a topic for blog-worthiness.

    source_priority: 0=best (HN), 1=good (News API), 2=fallback (Tavily)
    """
    score = 100.0 - (source_priority * 30)  # HN: 100, News: 70, Tavily: 40

    lower = title.lower()

    # ── Bonus: things people actually care about ──
    if any(w in lower for w in ["launch", "release", "announce", "unveil"]):
        score += 25  # new things people can use
    if any(w in lower for w in ["study finds", "research shows", "scientists discover"]):
        score += 20  # evidence-based, people trust this
    if any(w in lower for w in ["how to", "guide", "tips", "tricks"]):
        score += 20  # actionable, people love this
    if any(w in lower for w in ["free", "open source", "github"]):
        score += 15  # developers love free stuff
    if any(w in lower for w in ["security", "privacy", "hack", "vulnerability"]):
        score += 15  # affects everyone
    if any(w in lower for w in ["ai", "gpt", "llm", "model", "copilot"]):
        score += 15  # hot topic everyone follows
    if any(w in lower for w in ["billion", "million", "funding", "startup"]):
        score += 10  # business relevance
    if any(w in lower for w in ["health", "money", "save", "cost"]):
        score += 10  # personal relevance
    if any(w in lower for w in ["vs", "compare", "review", "worth"]):
        score += 10  # decision-making content
    if "?" in title:
        score += 5  # questions are engaging

    # ── Penalty: things nobody wants to read ──
    if len(title) < 30:
        score -= 25  # too short = low info
    if any(w in lower for w in ["opinion", "editorial", "column"]):
        score -= 20  # subjective, not factual
    if is_skip(title):
        score -= 100  # skip entirely

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
        # 1. HN — stories developers actually discuss
        print("Fetching Hacker News...", file=sys.stderr)
        hn_stories = fetch_hacker_news(30)
        for title, hn_score in hn_stories:
            if title not in used:
                scored.append((title, score_topic(title, 0) + min(hn_score / 10, 30)))

        # 2. Tavily — what tech people actually use/read about
        if tavily_key:
            tech_queries = [
                "new AI tools developers are using 2026",
                "best programming tools released this week",
                "popular open source projects trending",
                "new app features users love",
                "cybersecurity tips for regular users",
                "tech startup funding news",
            ]
            tav = fetch_tavily(tavily_key, tech_queries)
            print(f"Tavily tech: {len(tav)}", file=sys.stderr)
            for t in tav:
                if t not in used:
                    scored.append((t, score_topic(t, 2)))

        # 3. News API tech (backup)
        if api_key:
            news = fetch_news_api(api_key, "technology")
            print(f"News API tech: {len(news)}", file=sys.stderr)
            for t in news:
                if t not in used:
                    scored.append((t, score_topic(t, 1)))

    else:  # general
        # 1. News API general — relevant stories
        if api_key:
            news = fetch_news_api(api_key, "general")
            print(f"News API general: {len(news)}", file=sys.stderr)
            for t in news:
                if t not in used:
                    scored.append((t, score_topic(t, 0)))

        # 2. Tavily — what people actually care about
        if tavily_key:
            gen_queries = [
                "health tips backed by science 2026",
                "smart money saving strategies",
                "work life balance advice",
                "environment news affecting daily life",
                "technology changes affecting everyone",
                "science discoveries people can use",
            ]
            tav = fetch_tavily(tavily_key, gen_queries)
            print(f"Tavily general: {len(tav)}", file=sys.stderr)
            for t in tav:
                if t not in used:
                    scored.append((t, score_topic(t, 1)))

    # Deduplicate
    seen_titles: Set[str] = set()
    unique_scored = []
    for title, score in scored:
        key = title.lower().strip().rstrip(".!?")
        if key not in seen_titles:
            seen_titles.add(key)
            unique_scored.append((title, score))

    # Filter: skip junk + require relevance
    unique_scored = [(t, s) for t, s in unique_scored if not is_skip(t)]
    unique_scored = [(t, s) for t, s in unique_scored if is_relevant_to_people(t)]

    # Sort by score desc
    unique_scored.sort(key=lambda x: x[1], reverse=True)

    # Take top candidates
    top = unique_scored[:15]
    print(f"\nTop {len(top)} candidates:", file=sys.stderr)
    for i, (t, s) in enumerate(top[:5], 1):
        print(f"  {i}. [{s:.0f}] {t[:80]}", file=sys.stderr)

    if not top:
        fallback = "New AI tools and apps developers are using" if args.type == "tech" else "Science and tech changes affecting daily life"
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
