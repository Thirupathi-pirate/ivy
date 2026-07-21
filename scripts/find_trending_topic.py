#!/usr/bin/env python
"""Find topics worth writing about — relevant to people and tech enthusiasts.

Sources:
Tech: HN stories + India tech news + Dev.to + Lobsters + GitHub Trending + Tavily
General: India + US news + science/health Tavily queries

Multi-source velocity: topics appearing across multiple sources score higher.
"""

import argparse
import json
import os
import random
import sys
from pathlib import Path
from typing import Dict, List, Set, Tuple

from dotenv import load_dotenv

load_dotenv()  # Load .env for local runs; GitHub Actions sets env vars directly

import requests

USED_TOPICS_FILE = Path(__file__).parent / "used_topics.json"
MAX_USED = 200

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
}

# Skip these — not worth a blog post
SKIP_PATTERNS: Set[str] = {
    # Generic fluff
    "daily life", "culture around the world", "technology trends shaping",
    "latest news", "breaking news", "what's happening",
    "daily roundup", "weekly roundup", "morning briefing",
    "today's top", "today's biggest", "in case you missed",
    "things to know", "what to know",
    # Academic/niche
    "fundamentals of", "introduction to", "survey of",
    "paper on", "thesis on",
    # Old stuff
    "(2005)", "(2006)", "(2007)", "(2008)", "(2009)",
    "(2010)", "(2011)", "(2012)", "(2013)", "(2014)",
    "(2015)", "(2016)", "(2017)", "(2018)", "(2019)",
    # Pure politics
    "election", "polls", "senate", "congress", "democrat", "republican",
    # Celebrity gossip
    "celebrity", "gossip", "dating",
    # Business/finance — user said no business
    "raises", "valuation", "funding", "ipo", "stock", "market",
    "investor", "venture capital", "series a", "series b", "series c",
    "acquisition", "merger", "revenue", "profit", "loss",
    "wall street", "nasdaq", "s&p",
}


def load_used_topics() -> Set[str]:
    if USED_TOPICS_FILE.exists():
        try:
            with open(USED_TOPICS_FILE) as f:
                return set(json.load(f))
        except (json.JSONDecodeError, OSError):
            pass
    return set()


def save_used_topic(topic: str) -> None:
    used = load_used_topics()
    used.add(topic)
    used_list = list(used)[-MAX_USED:]
    USED_TOPICS_FILE.write_text(json.dumps(used_list, indent=2))


def is_skip(title: str) -> bool:
    lower = title.lower()
    return any(pat in lower for pat in SKIP_PATTERNS)


def is_relevant_to_people(title: str) -> bool:
    """Must match at least one signal that matters to real people."""
    lower = title.lower()
    signals = [
        # Tech people use
        "new", "update", "feature", "tool", "app", "free", "best",
        "how to", "guide", "tips", "tricks",
        "vs", "compare", "review", "worth",
        # People care about
        "health", "money", "save", "cost", "price", "deal",
        "security", "privacy", "safe", "protect",
        "work", "job", "career", "remote",
        "home", "family", "life",
        "science", "discover", "study finds", "research shows",
        "environment", "climate", "future",
        # Tech enthusiasts
        "launch", "release", "announce", "unveil",
        "open source", "github", "developer",
        "ai", "gpt", "llm", "model", "copilot",
        # India relevance
        "india", "indian", "isro", "trai", "rbi", "upi",
        "bharti", "jio", "infosys", "tcs", "wipro", "flipkart",
    ]
    return any(w in lower for w in signals)


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
    """Fetch HN top stories with parallel requests."""
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

    # ponytail: parallel fetch instead of sequential — 30x faster
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def _fetch(sid):
        try:
            r = requests.get(f"https://hacker-news.firebaseio.com/v0/item/{sid}.json", timeout=5)
            r.raise_for_status()
            item = r.json()
            if item and item.get("title"):
                return (item["title"], item.get("score", 0))
        except Exception:
            pass
        return None

    stories = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(_fetch, sid): sid for sid in story_ids}
        for f in as_completed(futures):
            result = f.result()
            if result:
                stories.append(result)

    return sorted(stories, key=lambda x: x[1], reverse=True)


# ── Dev.to (free, no API key) ──────────────────────────────────────

def fetch_devto(limit: int = 20) -> List[Tuple[str, str]]:
    """Fetch trending articles from Dev.to."""
    try:
        resp = requests.get(
            "https://dev.to/api/articles",
            params={"per_page": limit, "top": 7},  # top of last 7 days
            timeout=10,
            headers={"User-Agent": "IvyBlogBot/1.0"},
        )
        resp.raise_for_status()
        articles = resp.json()
        return [(a["title"], a.get("url", "")) for a in articles if a.get("title")]
    except Exception as e:
        print(f"Dev.to error: {e}", file=sys.stderr)
        return []


# ── Lobsters (free, no API key) ────────────────────────────────────

def fetch_lobsters(limit: int = 20) -> List[Tuple[str, str]]:
    """Fetch hot stories from Lobsters (Hacker News alternative)."""
    try:
        resp = requests.get(
            "https://lobste.rs/hottest.json",
            timeout=10,
        )
        resp.raise_for_status()
        stories = resp.json()
        return [
            (s["title"], s.get("url") or s.get("comments_url", ""))
            for s in stories[:limit]
            if s.get("title")
        ]
    except Exception as e:
        print(f"Lobsters error: {e}", file=sys.stderr)
        return []


# ── Indian News RSS (free, no API key) ─────────────────────────────

# Google News RSS — covers The Hindu, NDTV, Indian Express, TOI, etc.
INDIA_RSS_FEEDS = {
    "tech": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB?hl=en-IN&gl=IN&ceid=IN:en",
    "general": "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en",
}


def fetch_indian_rss(category: str = "general", limit: int = 20) -> List[str]:
    """Fetch Indian news from Google News RSS — covers all major Indian publications."""
    try:
        import feedparser
        url = INDIA_RSS_FEEDS.get(category, INDIA_RSS_FEEDS["general"])
        feed = feedparser.parse(url)
        titles = []
        for entry in feed.entries[:limit]:
            if entry.get("title"):
                titles.append(entry["title"])
        return titles
    except Exception as e:
        print(f"Indian RSS ({category}) error: {e}", file=sys.stderr)
        return []


def fetch_indian_tech_rss(limit: int = 20) -> List[str]:
    """Fetch Indian tech news specifically."""
    try:
        import feedparser
        # Also try Medianama (Indian tech publication)
        feed = feedparser.parse("https://medianama.com/feed/")
        titles = [e["title"] for e in feed.entries[:limit] if e.get("title")]
        # Add Google News India tech
        titles.extend(fetch_indian_rss("tech", limit))
        return titles[:limit]
    except Exception as e:
        print(f"Indian tech RSS error: {e}", file=sys.stderr)
        return []


# ── GitHub Trending (free, no API key) ─────────────────────────────

def fetch_github_trending(language: str = "", since: str = "daily") -> List[Tuple[str, str]]:
    """Fetch trending repos from GitHub (scrapes the trending page)."""
    try:
        url = "https://github.com/trending"
        if language:
            url += f"/{language}"
        resp = requests.get(
            url,
            params={"since": since},
            timeout=10,
            headers={"User-Agent": "IvyBlogBot/1.0", "Accept": "text/html"},
        )
        resp.raise_for_status()
        # Simple regex extraction from HTML
        import re
        titles = re.findall(r'<h2 class="h3 lh-condensed">.*?<a href="/([^"]+)"', resp.text, re.DOTALL)
        if not titles:
            # Fallback: extract repo names
            titles = re.findall(r'href="/([^/]+/[^"]+)"[^>]*>\s*\n\s*([^<]+)', resp.text)
            return [(f"{owner}/{name.strip()}", f"https://github.com/{owner}/{name.strip()}") for owner, name in titles[:10] if "/" in f"{owner}/{name}"]
        return [(t.strip(), f"https://github.com/{t.strip()}") for t in titles[:10]]
    except Exception as e:
        print(f"GitHub Trending error: {e}", file=sys.stderr)
        return []


# ── News API ────────────────────────────────────────────────────────

def fetch_news_api(api_key: str, category: str, country: str = "us") -> List[str]:
    try:
        resp = requests.get(
            "https://newsapi.org/v2/top-headlines",
            params={"apiKey": api_key, "country": country, "pageSize": 20, "category": category},
            timeout=10,
        )
        resp.raise_for_status()
        return [a["title"] for a in resp.json().get("articles", []) if a.get("title")]
    except Exception as e:
        print(f"News API ({country}) error: {e}", file=sys.stderr)
        return []

# ── Currents API (free, 1,000 req/day) ──────────────────────────

def fetch_currents(api_key: str, country: str = "IN", category: str = "general", language: str = "en", limit: int = 20) -> List[str]:
"""Fetch news from Currents API — real-time, 120k+ sources, 1,000 free req/day."""
try:
resp = requests.get(
"https://api.currentsapi.services/v1/latest-news",
params={"country": country, "language": language, "category": category, "page_size": limit},
headers={"Authorization": api_key},
timeout=10,)
resp.raise_for_status()
data = resp.json()
if data.get("status") != "ok":
return []
return [a["title"] for a in data.get("news", []) if a.get("title")]
except Exception as e:
print(f"Currents API ({country}/{category}) error: {e}", file=sys.stderr)
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
    """Score a topic for blog-worthiness. source_priority: 0=best, 1=good, 2=fallback"""
    score = 100.0 - (source_priority * 30)

    lower = title.lower()

    # Bonus: things people actually care about
    if any(w in lower for w in ["launch", "release", "announce", "unveil"]):
        score += 25
    if any(w in lower for w in ["study finds", "research shows", "scientists discover"]):
        score += 20
    if any(w in lower for w in ["how to", "guide", "tips", "tricks"]):
        score += 20
    if any(w in lower for w in ["free", "open source", "github"]):
        score += 15
    if any(w in lower for w in ["security", "privacy", "hack", "vulnerability"]):
        score += 15
    if any(w in lower for w in ["ai", "gpt", "llm", "model", "copilot"]):
        score += 15
    if any(w in lower for w in ["health", "money", "save", "cost"]):
        score += 10
    if any(w in lower for w in ["vs", "compare", "review", "worth"]):
        score += 10
    if "?" in title:
        score += 5

    # Penalty: things nobody wants to read
    if len(title) < 30:
        score -= 25
    if any(w in lower for w in ["opinion", "editorial", "column"]):
        score -= 20
    if is_skip(title):
        score -= 100

    return score


def velocity_bonus(title: str, source_counts: Dict[str, int]) -> float:
    """Bonus for topics appearing across multiple sources."""
    sources_mentioned = 0
    for source_name, count in source_counts.items():
        if count > 0:
            sources_mentioned += 1

    if sources_mentioned >= 4:
        return 30  # Very hot topic
    elif sources_mentioned >= 3:
        return 20
    elif sources_mentioned >= 2:
        return 10
    return 0


# ── Main ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Find a trending topic for blog writing")
    parser.add_argument("--type", choices=["tech", "general"], default="general")
    args = parser.parse_args()

    api_key = os.environ.get("NEWS_API_KEY", "")
tavily_key = os.environ.get("TAVILY_API_KEY", "") #SS
currents_key = os.environ.get("CURRENTS_API_KEY", "")
    used = load_used_topics()

    scored: List[Tuple[str, float]] = []
    source_counts: Dict[str, int] = {}  # Track how many items each source contributes

    if args.type == "tech":
        # 1. HN — stories developers discuss
        print("Fetching Hacker News...", file=sys.stderr)
        hn_stories = fetch_hacker_news(30)
        source_counts["hackernews"] = len(hn_stories)
        for title, hn_score in hn_stories:
            if title not in used:
                scored.append((title, score_topic(title, 0) + min(hn_score / 10, 30)))

        # 2. Dev.to — developer articles
        print("Fetching Dev.to...", file=sys.stderr)
        devto_articles = fetch_devto(20)
        source_counts["devto"] = len(devto_articles)
        for title, url in devto_articles:
            if title not in used:
                scored.append((title, score_topic(title, 0) + 5))

        # 3. Lobsters — tech stories
        print("Fetching Lobsters...", file=sys.stderr)
        lobster_stories = fetch_lobsters(20)
        source_counts["lobsters"] = len(lobster_stories)
        for title, url in lobster_stories:
            if title not in used:
                scored.append((title, score_topic(title, 0) + 5))

        # 4. GitHub Trending
        print("Fetching GitHub Trending...", file=sys.stderr)
        gh_trending = fetch_github_trending()
        source_counts["github"] = len(gh_trending)
        for title, url in gh_trending:
            if title not in used:
                scored.append((title, score_topic(title, 0) + 10))

        # 5. News API — India tech
        if api_key:
            india_tech = fetch_news_api(api_key, "technology", country="in")
            print(f"News API India tech: {len(india_tech)}", file=sys.stderr)
            source_counts["newsapi_india"] = len(india_tech)
            for t in india_tech:
                if t not in used:
                    scored.append((t, score_topic(t, 0)))

        # 5b. Indian RSS — Google News India tech (free, no API key)
        print("Fetching Indian tech RSS...", file=sys.stderr)
        indian_tech = fetch_indian_tech_rss(20)
        source_counts["indian_rss"] = len(indian_tech)
        print(f"Indian tech RSS: {len(indian_tech)}", file=sys.stderr)
        for t in indian_tech:
            if t not in used:
                scored.append((t, score_topic(t, 0)))

        # 6. Tavily — what tech people actually use
        if tavily_key:
            tech_queries = [
                "new AI tools developers are using 2026",
                "India tech news trending",
                "best free tools for productivity",
            ]
            tav = fetch_tavily(tavily_key, tech_queries)
            print(f"Tavily tech: {len(tav)}", file=sys.stderr)
            source_counts["tavily"] = len(tav)
            for t in tav:
                if t not in used:
                    scored.append((t, score_topic(t, 2)))

        # 7. News API US tech (backup)
        if api_key:
            us_tech = fetch_news_api(api_key, "technology", country="us")
            print(f"News API US tech: {len(us_tech)}", file=sys.stderr)
            source_counts["newsapi_us"] = len(us_tech)
            for t in us_tech:
                if t not in used:
                    scored.append((t, score_topic(t, 1)))

# 8. Currents API — trending tech news (free, no hard India focus)
if currents_key:
currents_tech = fetch_currents(currents_key, category="technology", limit=15)
print(f"Currents tech: {len(currents_tech)}", file=sys.stderr)
source_counts["currents"] = len(currents_tech)
for t in currents_tech:
if t not in used:
scored.append((t, score_topic(t, 0)))

    else:  # general
        # 1. News API India general — primary source
        if api_key:
            india_gen = fetch_news_api(api_key, "general", country="in")
            print(f"News API India general: {len(india_gen)}", file=sys.stderr)
            source_counts["newsapi_india"] = len(india_gen)
            for t in india_gen:
                if t not in used:
                    scored.append((t, score_topic(t, 0)))

        # 1b. Indian RSS — Google News India general (free, no API key)
        print("Fetching Indian general RSS...", file=sys.stderr)
        indian_gen = fetch_indian_rss("general", 20)
        source_counts["indian_rss"] = len(indian_gen)
        print(f"Indian general RSS: {len(indian_gen)}", file=sys.stderr)
        for t in indian_gen:
            if t not in used:
                scored.append((t, score_topic(t, 0)))

        # 2. News API US general
        if api_key:
            us_gen = fetch_news_api(api_key, "general", country="us")
            print(f"News API US general: {len(us_gen)}", file=sys.stderr)
            source_counts["newsapi_us"] = len(us_gen)
            for t in us_gen:
                if t not in used:
                    scored.append((t, score_topic(t, 1)))

        # 3. Tavily — what people actually care about
        if tavily_key:
            gen_queries = [
                "health tips backed by science 2026",
                "smart money saving strategies",
                "work life balance advice",
                "environment news affecting daily life",
                "technology changes affecting everyone",
                "science discoveries people can use",
                "India news people care about",
                "best habits for healthy life",
            ]
            tav = fetch_tavily(tavily_key, gen_queries)
            print(f"Tavily general: {len(tav)}", file=sys.stderr)
            source_counts["tavily"] = len(tav)
            for t in tav:
                if t not in used:
                    scored.append((t, score_topic(t, 1)))

# 4. Currents API — trending general news (free, no hard India focus)
if currents_key:
currents_gen = fetch_currents(currents_key, category="general", limit=15)
print(f"Currents general: {len(currents_gen)}", file=sys.stderr)
source_counts["currents"] = len(currents_gen)
for t in currents_gen:
if t not in used:
scored.append((t, score_topic(t, 0)))

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
    top = unique_scored[:20]
    print(f"\nTop {len(top)} candidates:", file=sys.stderr)
    for i, (t, s) in enumerate(top[:7], 1):
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
