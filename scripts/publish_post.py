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


def fetch_unsplash_images(topic: str, count: int = 2) -> list:
    if not UNSPLASH_ACCESS_KEY:
        return []
    try:
        url = "https://api.unsplash.com/search/photos"
        params = {"query": topic, "per_page": count, "orientation": "landscape"}
        headers = {"Authorization": f"Client-ID {UNSPLASH_ACCESS_KEY}"}
        r = requests.get(url, params=params, headers=headers, timeout=10)
        data = r.json()
        results = data.get("results", [])
        images = []
        for img in results[:count]:
            # Fire download notification (required by API terms)
            requests.get(img["links"]["download_location"], headers=headers, timeout=5)
            images.append({
                "path": img["urls"]["raw"] + "&fm=webp",
                "alt": img.get("alt_description") or topic,
                "photographer": img["user"]["name"],
                "photographer_url": img["user"]["links"]["html"],
                "unsplash_url": img["links"]["html"],
                "download_location": img["links"]["download_location"],
            })
        return images
    except Exception as e:
        print(f"Unsplash fetch failed: {e}", file=sys.stderr)
        return []


def build_frontmatter(title: str, topic: str, description: str, unsplash: dict | None, mermaid: bool) -> str:
    now = datetime.now()
    date = now.strftime("%Y-%m-%d %H:%M:%S %z")
    lines = ["---", "layout: post", f'title: "{title}"', f"date: {date}", "toc: true"]
    if mermaid:
        lines.append("mermaid: true")
    if unsplash:
        lines.extend([
            "image:",
            f'  path: "{unsplash["path"]}&w=1200&h=630&fit=crop"',
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
            "  alt: Ivy",
        ])
    lines.append("---")
    return "\n".join(lines)


def insert_inline_image(content: str, img: dict | None) -> str:
    """Insert an inline image after the intro, before the first section heading."""
    if not img:
        return content
    idx = content.find("\n## ")
    if idx == -1:
        return content
    insert_pos = content.rfind("\n\n", 0, idx)
    if insert_pos == -1:
        insert_pos = idx
    image_block = (
        f'\n\n<div class="post-hero">\n'
        f'  <img src="{img["path"]}&w=780&h=440&fit=crop"'
        f' alt="{img["alt"]}" loading="lazy" width="780" height="440"'
        f' data-unsplash-dl="{img["download_location"]}" />\n'
        f'  <div class="post-hero-credit">📸'
        f' <a href="{img["photographer_url"]}">{img["photographer"]}</a>'
        f' on <a href="{img["unsplash_url"]}">Unsplash</a></div>\n'
        f'</div>\n'
    )
    return content[:insert_pos] + image_block + content[insert_pos:]


def build_attribution(images: list) -> str:
    if not images:
        return ""
    parts = ["\n\n---\n"]
    for i, img in enumerate(images):
        parts.append(
            f"\n{i + 1}. 📸 {img['photographer']} —"
            f" [{img['photographer']}]({img['photographer_url']})"
            f" on [Unsplash]({img['unsplash_url']})"
        )
    parts.append("\n")
    return "".join(parts)


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

    images = fetch_unsplash_images(topic)
    cover = images[0] if len(images) > 0 else None
    inline_img = images[1] if len(images) > 1 else None

    mermaid = has_mermaid(content)

    frontmatter = build_frontmatter(title, topic, desc, cover, mermaid)
    body = re.sub(r"^# .+\n?", "", content, count=1).strip()
    body = insert_inline_image(body, inline_img)
    attribution = build_attribution(images)
    post_content = frontmatter + "\n\n" + body + attribution

    post_filename = f"{today}-{slug}.md"
    post_path = POSTS_DIR / post_filename

    POSTS_DIR.mkdir(parents=True, exist_ok=True)
    post_path.write_text(post_content, encoding="utf-8")

    print(f"Published: {post_path}")
    print(f"URL slug: {slug}")
    if cover:
        print(f"Cover: {cover['path']}")
    if inline_img:
        print(f"Inline: {inline_img['path']}")
    if mermaid:
        print("Mermaid: true")


if __name__ == "__main__":
    main()
