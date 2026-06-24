#!/usr/bin/env python
"""Convert crew output to Jekyll post and deploy."""

import os
import re
import sys
from datetime import datetime
from pathlib import Path


POSTS_DIR = Path(__file__).resolve().parent.parent / "blog-source" / "_posts"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"
BLOG_POST = OUTPUT_DIR / "blog_post.md"


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


def build_frontmatter(title: str, topic: str, description: str) -> str:
    now = datetime.now()
    date = now.strftime("%Y-%m-%d %H:%M:%S %z")
    return f"""---
title: {title}
date: {date}
description: >-
  {description}
pin: false
image:
  path: /assets/avatar.webp
  alt: Daily Blog
---
"""


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

    post_filename = f"{today}-{slug}.md"
    post_path = POSTS_DIR / post_filename

    frontmatter = build_frontmatter(title, topic, desc)
    body = re.sub(r"^# .+\n?", "", content, count=1).strip()
    post_content = frontmatter + "\n" + body

    POSTS_DIR.mkdir(parents=True, exist_ok=True)
    post_path.write_text(post_content, encoding="utf-8")

    print(f"Published: {post_path}")
    print(f"URL slug: {slug}")


if __name__ == "__main__":
    main()
