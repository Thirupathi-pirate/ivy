#!/usr/bin/env python
"""Convert crew output to Jekyll post and deploy."""

import os
import re
import sys
from datetime import datetime
from pathlib import Path

import requests


POSTS_DIR = Path(__file__).resolve().parent.parent / "blog-source" / "_posts"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"
BLOG_POST = OUTPUT_DIR / "blog_post.md"

UNSPLASH_ACCESS_KEY = os.environ.get("UNSPLASH_ACCESS_KEY", "")


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-")


def extract_title(content: str) -> str:
    for line in content.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return "Untitled Post"


def extract_first_paragraph(content: str) -> str:
    for line in content.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return stripped[:150]
    return ""


def has_mermaid(content: str) -> bool:
    return "```mermaid" in content


def fetch_unsplash_image(topic: str) -> dict | None:
    if not UNSPLASH_ACCESS_KEY:
        return None
    try:
        url = "https://api.unsplash.com/search/photos"
        params = {"query": topic, "per_page": 1, "orientation": "landscape"}
        headers = {"Authorization": f"Client-ID {UNSPLASH_ACCESS_KEY}"}
        r = requests.get(url, params=params, headers=headers, timeout=10)
        data = r.json()
        if not data.get("results"):
            return None
        img = data["results"][0]
        # Fire download notification (required by API terms)
        requests.get(img["links"]["download_location"], headers=headers, timeout=5)
        return {
            "path": img["urls"]["raw"] + "&w=1200&h=630&fit=crop",
            "alt": img.get("alt_description") or topic,
            "photographer": img["user"]["name"],
            "photographer_url": img["user"]["links"]["html"],
            "unsplash_url": img["links"]["html"],
            "download_location": img["links"]["download_location"],
        }
    except Exception as e:
        print(f"Unsplash fetch failed: {e}", file=sys.stderr)
        return None


def build_frontmatter(title: str, topic: str, description: str, unsplash: dict | None, mermaid: bool) -> str:
    now = datetime.now()
    date = now.strftime("%Y-%m-%d %H:%M:%S %z")
    lines = ["---", "layout: post", f'title: "{title}"', f"date: {date}", "toc: true"]
    if mermaid:
        lines.append("mermaid: true")
    if unsplash:
        lines.extend([
            "image:",
            f'  path: "{unsplash["path"]}"',
            f'  alt: "{unsplash["alt"]}"',
            "  photographer: " + unsplash['photographer'],
            "  photographer_url: " + unsplash['photographer_url'],
            "  unsplash_url: " + unsplash['unsplash_url'],
        ])
    else:
        lines.extend([
            "description: >-",
            f"  {description}",
            "pin: false",
            "image:",
            "  path: /assets/avatar.webp",
            "  alt: Daily Blog",
        ])
    lines.append("---")
    return "\n".join(lines)


def build_attribution(unsplash: dict | None) -> str:
    if not unsplash:
        return ""
    return (
        "\n\n---\n\n"
        f"*📸 Cover photo by [{unsplash['photographer']}]({unsplash['photographer_url']}) "
        f"on [Unsplash]({unsplash['unsplash_url']})*\n"
    )


def main():
    topic = sys.argv[1] if len(sys.argv) > 1 else "Technology"

    if not BLOG_POST.exists():
        print(f"Error: {BLOG_POST} not found")
        sys.exit(1)

    content = BLOG_POST.read_text(encoding="utf-8")
    title = extract_title(content)
    desc = extract_first_paragraph(content)
    slug = slugify(topic)
    today = datetime.now().strftime("%Y-%m-%d")

    # Fetch Unsplash image
    unsplash = fetch_unsplash_image(topic)

    # Detect mermaid
    mermaid = has_mermaid(content)

    post_filename = f"{today}-{slug}.md"
    post_path = POSTS_DIR / post_filename

    frontmatter = build_frontmatter(title, topic, desc, unsplash, mermaid)
    body = re.sub(r"^# .+\n?", "", content, count=1).strip()
    attribution = build_attribution(unsplash)
    post_content = frontmatter + "\n\n" + body + attribution

    POSTS_DIR.mkdir(parents=True, exist_ok=True)
    post_path.write_text(post_content, encoding="utf-8")

    print(f"Published: {post_path}")
    print(f"URL slug: {slug}")
    if unsplash:
        print(f"Cover: {unsplash['path']}")
    if mermaid:
        print("Mermaid: true")


if __name__ == "__main__":
    main()
