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
            try:
                requests.get(img["links"]["download_location"], headers=headers, timeout=5)
            except Exception:
                pass
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


def yaml_escape(s: str) -> str:
    """Escape double quotes in a YAML double-quoted string."""
    return s.replace("\\", "\\\\").replace('"', '\\"')

def build_frontmatter(title: str, topic: str, description: str, unsplash: dict | None, mermaid: bool) -> str:
    now = datetime.now().astimezone()
    date = now.strftime("%Y-%m-%d %H:%M:%S %z")
    lines = ["---", "layout: post", f'title: "{yaml_escape(title)}"', f"date: {date}", "toc: true"]
    if mermaid:
        lines.append("mermaid: true")
    if unsplash:
        lines.extend([
            "description: >-",
            f"  {description}",
            "image:",
            f'  path: "{unsplash["path"]}&w=1200&h=630&fit=crop"',
            f'  alt: "{yaml_escape(unsplash["alt"])}"',
            f'  photographer: "{yaml_escape(unsplash["photographer"])}"',
            f'  photographer_url: "{yaml_escape(unsplash["photographer_url"])}"',
            f'  unsplash_url: "{yaml_escape(unsplash["unsplash_url"])}"',
        ])
    else:
        lines.extend([
            "description: >-",
            f"  {description}",
        ])
    lines.append("---")
    return "\n".join(lines)


def insert_inline_image(content: str, img: dict | None) -> str:
    """Insert a post-hero image after the first \n##  heading's paragraph."""
    if not img:
        return content
    idx = content.find("\n## ")
    if idx == -1 and content.startswith("## "):
        idx = 0
    if idx != -1:
        # Find end of heading line
        eol = content.find("\n", idx + 1)
        if eol == -1:
            eol = idx
        # Find the next paragraph break after the heading
        para = content.find("\n\n", eol)
        if para != -1:
            insert_pos = para
        else:
            insert_pos = eol
    else:
        insert_pos = content.find("\n\n") if content.find("\n\n") != -1 else 0
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



def main():
    topic = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TOPIC", "The Future of AI Agents")

    if not BLOG_POST.exists():
        print(f"Error: {BLOG_POST} not found")
        sys.exit(1)

    content = BLOG_POST.read_text(encoding="utf-8")
    title = extract_title(content)
    desc = extract_first_paragraph(content)
    slug = slugify(topic)
    today = datetime.now().strftime("%Y-%m-%d")

    # Short query for Unsplash — first 3 meaningful words
    query = " ".join(topic.split()[:3])
    images = fetch_unsplash_images(query)
    cover = images[0] if len(images) > 0 else None
    inline_img = images[1] if len(images) > 1 and images[1]["path"] != images[0]["path"] else None

    mermaid = has_mermaid(content)

    frontmatter = build_frontmatter(title, topic, desc, cover, mermaid)
    body = re.sub(r"^# .+\n?", "", content, count=1).strip()
    # Insert inline image inside the first content section
    if inline_img:
        body = insert_inline_image(body, inline_img)
    post_content = frontmatter + "\n\n" + body

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
