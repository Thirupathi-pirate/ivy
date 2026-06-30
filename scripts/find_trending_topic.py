#!/usr/bin/env python
"""Find trending topics using Google Trends + News API."""

import argparse
import os
import random
import sys
from typing import List

import requests

try:
    from pytrends.request import TrendReq as _TrendReq
    HAS_PYTRENDS = True
except ImportError:
    HAS_PYTRENDS = False

TECH_KEYWORDS = [
    "ai", "artificial intelligence", "machine learning", "llm", "gpt",
    "chatgpt", "openai", "google ai", "meta ai",
    "tech", "technology", "startup", "software", "programming",
    "crypto", "blockchain", "bitcoin", "nft", "web3",
    "smartphone", "iphone", "android", "ios",
    "cybersecurity", "hack", "data breach",
    "cloud", "saas", "data center",
    "robot", "automation", "chip", "semiconductor",
    "quantum", "neural", "deep learning", "data science",
    "app", "api", "database",
    "devops", "kubernetes", "docker",
    "computer", "laptop", "gadget", "wearable",
    "electric vehicle", "ev", "tesla",
    "spacex", "nasa", "space",
    "internet", "broadband", "5g", "6g",
    "streaming", "netflix", "youtube",
    "gaming", "playstation", "xbox", "nintendo",
    "vr", "ar", "virtual reality", "augmented reality",
    "nvidia", "intel", "amd",
    "apple", "samsung", "google", "microsoft", "amazon",
    "meta", "twitter", "x corp",
    "algorithm", "big data", "analytics",
    "defi", "web3",
    "github", "open source",
    "chatbot", "copilot",
    "cyber", "ransomware",
    "autonomous", "self-driving",
    "drone", "robotics",
    "biotech", "gene", "dna", "crispr",
    "renewable", "solar", "wind energy",
    "battery", "lithium",
    "space", "rocket", "satellite",
    "ai model", "ai tool", "ai system",
    "javascript", "python", "rust", "typescript",
    "react", "nextjs", "angular", "vue",
    "aws", "azure", "gcp",
    "serverless", "microservice",
    "blockchain", "nft", "metaverse",
    "digital", "online", "platform",
    "smart", "connected", "iot",
    "algorithm", "recommendation",
    "browser", "extension", "plugin",
    "os", "windows", "linux", "macos",
    "console", "gpu", "cpu",
    "display", "oled", "led", "hdr",
    "sensor", "camera", "processor",
    "wifi", "bluetooth", "nfc",
    "cloud", "virtualization",
    "container", "kubernetes",
    "api", "rest", "graphql",
    "framework", "library",
    "sdk", "cli", "ide",
    "keyword": "security",
    "vulnerability", "patch", "update",
]


def newsapi_trending(api_key: str, category: str = "general", country: str = "us") -> List[str]:
    url = "https://newsapi.org/v2/top-headlines"
    try:
        resp = requests.get(
            url,
            params={"apiKey": api_key, "country": country, "pageSize": 20, "category": category},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        return [a["title"] for a in data.get("articles", []) if a.get("title")]
    except Exception as e:
        print(f"News API error: {e}", file=sys.stderr)
        return []


def google_trends_trending() -> List[str]:
    if not HAS_PYTRENDS:
        return []
    try:
        pytrends = _TrendReq(hl="en-US", tz=360, timeout=10)
        trending = pytrends.trending_searches(pn="united_states")
        if not trending.empty:
            return trending[0].tolist()
        return []
    except Exception as e:
        print(f"Google Trends error: {e}", file=sys.stderr)
        return []


def google_trends_realtime() -> List[str]:
    if not HAS_PYTRENDS:
        return []
    try:
        pytrends = _TrendReq(hl="en-US", tz=360, timeout=10)
        realtime = pytrends.realtime_trending_searches(pn="US")
        if realtime is not None and not realtime.empty:
            titles = []
            for _, row in realtime.iterrows():
                title = row.get("title", "")
                if title:
                    titles.append(title)
            return titles
        return []
    except Exception as e:
        print(f"Google Trends realtime error: {e}", file=sys.stderr)
        return []


def filter_tech(titles: List[str]) -> List[str]:
    result = []
    for t in titles:
        tl = t.lower()
        if any(kw.lower() in tl for kw in TECH_KEYWORDS):
            result.append(t)
    return result


def filter_general(titles: List[str]) -> List[str]:
    result = []
    for t in titles:
        tl = t.lower()
        if not any(kw.lower() in tl for kw in TECH_KEYWORDS):
            result.append(t)
    return result


def deduplicate(titles: List[str]) -> List[str]:
    seen = set()
    result = []
    for t in titles:
        key = t.lower().strip()
        if key not in seen:
            seen.add(key)
            result.append(t)
    return result


def main():
    parser = argparse.ArgumentParser(description="Find a trending topic for blog writing")
    parser.add_argument("--type", choices=["tech", "general"], default="general", help="Type of topic to find")
    args = parser.parse_args()

    all_titles = []

    # 1. Google Trends — daily trending searches
    gt = google_trends_trending()
    print(f"Google Trends daily: {len(gt)} results", file=sys.stderr)
    all_titles.extend(gt)

    # 2. Google Trends — realtime trending (more current)
    rt = google_trends_realtime()
    print(f"Google Trends realtime: {len(rt)} results", file=sys.stderr)
    all_titles.extend(rt)

    # 3. News API (if key available)
    news_key = os.environ.get("NEWS_API_KEY")
    if news_key:
        cat = "technology" if args.type == "tech" else "general"
        news = newsapi_trending(news_key, category=cat)
        print(f"News API ({cat}): {len(news)} results", file=sys.stderr)
        all_titles.extend(news)

    # Filter by type
    if args.type == "tech":
        candidates = filter_tech(all_titles)
        fallback = "Latest technology trends shaping our future"
    else:
        candidates = filter_general(all_titles)
        fallback = "Interesting stories trending around the world today"

    unique = deduplicate(candidates)
    print(f"Candidates after filtering ({args.type}): {len(unique)}", file=sys.stderr)

    if not unique:
        # No candidates found — use search queries directly
        print(f"No candidates found, using Tavily fallback...", file=sys.stderr)
        try:
            from tavily import TavilyClient
            client = TavilyClient(api_key=os.environ.get("TAVILY_API_KEY", ""))
            q = "trending technology news today" if args.type == "tech" else "trending topics today viral news"
            r = client.search(query=q, max_results=5, search_depth="basic")
            results = r.get("results", [])
            unique = [res.get("title", "") for res in results if res.get("title")]
            print(f"Tavily fallback: {len(unique)} results", file=sys.stderr)
        except Exception as e:
            print(f"Tavily fallback error: {e}", file=sys.stderr)

    if not unique:
        print(fallback)
        return

    topic = random.choice(unique[:20])
    print(f"Selected: {topic}", file=sys.stderr)
    print(topic)


if __name__ == "__main__":
    main()
