#!/usr/bin/env python
"""Find trending topics using News API + Tavily + Reddit."""

import argparse
import json
import os
import random
import sys
from pathlib import Path
from typing import List, Set

import requests

USED_TOPICS_FILE = Path(__file__).parent / "used_topics.json"
MAX_USED = 100  # ponytail: cap to avoid unbounded growth

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


def newsapi_top(api_key: str, category: str = "general") -> List[str]:
    url = "https://newsapi.org/v2/top-headlines"
    try:
        resp = requests.get(
            url,
            params={"apiKey": api_key, "country": "us", "pageSize": 20, "category": category},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        return [a["title"] for a in data.get("articles", []) if a.get("title")]
    except Exception as e:
        print(f"News API error: {e}", file=sys.stderr)
        return []


def tavily_search(api_key: str, query: str) -> List[str]:
    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=api_key)
        r = client.search(query=query, max_results=10, search_depth="basic")
        return [res.get("title", "") for res in r.get("results", []) if res.get("title")]
    except Exception as e:
        print(f"Tavily error: {e}", file=sys.stderr)
        return []


def filter_tech(titles: List[str]) -> List[str]:
    return [t for t in titles if any(kw.lower() in t.lower() for kw in TECH_KEYWORDS)]


def filter_general(titles: List[str]) -> List[str]:
    return [t for t in titles if not any(kw.lower() in t.lower() for kw in TECH_KEYWORDS)]


def deduplicate(titles: List[str]) -> List[str]:
    seen: Set[str] = set()
    result = []
    for t in titles:
        key = t.lower().strip().rstrip(".!?")
        if key not in seen:
            seen.add(key)
            result.append(t)
    return result


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


def main():
    parser = argparse.ArgumentParser(description="Find a trending topic for blog writing")
    parser.add_argument("--type", choices=["tech", "general"], default="general")
    args = parser.parse_args()

    api_key = os.environ.get("NEWS_API_KEY", "")
    tavily_key = os.environ.get("TAVILY_API_KEY", "")
    all_titles: List[str] = []

    # 1. News API — reliable, free 100 req/day
    if api_key:
        news_cat = "technology" if args.type == "tech" else "general"
        news = newsapi_top(api_key, category=news_cat)
        print(f"News API ({news_cat}): {len(news)}", file=sys.stderr)
        all_titles.extend(news)

    # 2. Tavily — targeted searches for trending topics
    if tavily_key:
        queries = [
            "trending technology news today" if args.type == "tech" else "trending topics today viral news",
            "what is trending on the internet today",
            "popular stories right now",
            "what people are talking about today",
        ]
        for q in queries:
            results = tavily_search(tavily_key, q)
            print(f"Tavily '{q[:30]}': {len(results)}", file=sys.stderr)
            all_titles.extend(results)

    # Filter by type
    candidates = filter_tech(all_titles) if args.type == "tech" else filter_general(all_titles)
    unique = deduplicate(candidates)
    print(f"Candidates ({args.type}): {len(unique)}", file=sys.stderr)

    # Filter out previously used topics
    used = load_used_topics()
    fresh = [t for t in unique if t not in used]
    print(f"Fresh (after excluding {len(used)} used): {len(fresh)}", file=sys.stderr)

    fallback = "Latest technology trends shaping our future" if args.type == "tech" else "Daily life and culture around the world"
    if not fresh:
        print(fallback)
        return

    topic = random.choice(fresh[:20])
    print(f"Selected: {topic}", file=sys.stderr)
    print(topic)
    save_used_topic(topic)  # track selection to avoid repeats


if __name__ == "__main__":
    main()
