#!/usr/bin/env python3
"""One-off repair for blog-source/_posts/*.md affected by CrewAI LLM leakage.

Fixes:
1. Surgically removes leading stray ```yaml fence blocks (duplicate frontmatter)
   that the LLM injected at the top of the body. Preserves post-hero images.
2. For ```thought reasoning leaks: cuts the body at the LAST real H1. This drops
   the reasoning block AND any earlier duplicate article copies, keeping the
   final (most complete) copy.
3. Collapses duplicate consecutive H1 title lines (LLM sometimes emitted two).
4. Regenerates `description:` when it captured a fence line (e.g. "```thought").
5. Fixes "Untitled Post" titles where a real heading exists in the body.

Safe to re-run; git tracks originals for rollback.
"""

import glob
import re
import sys
from pathlib import Path

POSTS_DIR = Path(__file__).resolve().parent.parent / "blog-source" / "_posts"

LEAK_LANGS = {"yaml", "thought"}


def split_frontmatter(text: str):
    """Return (frontmatter, body) or (None, None)."""
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        return None, None
    return m.group(1), m.group(2)


def repair_body(body: str) -> str:
    lines = body.splitlines()

    # --- 1. Strip leading stray fence blocks (```yaml / ```thought) ---
    start = 0
    while start < len(lines) and not lines[start].strip():
        start += 1
    if start < len(lines) and lines[start].strip().startswith("```"):
        lang = lines[start].strip()[3:].strip()
        h1_idxs = [i for i, l in enumerate(lines) if l.startswith("# ")]
        if lang == "thought":
            # Reasoning leak: the real article begins at the LAST H1 line.
            # (Fake "# I will..." reasoning lines always precede the real H1,
            #  and duplicated article copies mean the final H1 is the best copy.)
            if h1_idxs:
                lines = lines[h1_idxs[-1]:]
            else:
                # No H1 anywhere — drop the whole leading thought block
                j = start + 1
                while j < len(lines) and lines[j].strip() != "```":
                    j += 1
                lines = lines[min(j + 1, len(lines)):]
        elif lang == "yaml":
            # Stray duplicate frontmatter — remove the closed fence block only,
            # keeping any post-hero image and the article that follows.
            j = start + 1
            while j < len(lines) and lines[j].strip() != "```":
                j += 1
            j += 1  # past closing fence
            while j < len(lines) and not lines[j].strip():
                j += 1
            lines = lines[j:]
        # other top fences (mermaid) are legit — leave untouched

    # --- 2. Collapse duplicate consecutive H1 lines ---
    out = []
    last_non_blank = ""
    for line in lines:
        if line.startswith("# ") and last_non_blank.startswith("# "):
            continue  # duplicate title line
        out.append(line)
        if line.strip():
            last_non_blank = line
    return "\n".join(out).strip() + "\n"


def first_paragraph(body: str) -> str:
    """First real prose line: not a heading, fence, image, blockquote, or div."""
    in_fence = False
    for line in body.splitlines():
        s = line.strip()
        if s.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if (
            s
            and not s.startswith("#")
            and not s.startswith(">")
            and not s.startswith("<div")
            and not s.startswith("![")
            and not s.startswith("---")
        ):
            return s[:150]
    return ""


def first_heading(body: str) -> str:
    for line in body.splitlines():
        m = re.match(r"^#{1,2} (.+)$", line.strip())
        if m:
            return m.group(1).strip()[:60]
    return ""


def main() -> None:
    files = sorted(glob.glob(str(POSTS_DIR / "*.md")))
    changed = 0
    for path in files:
        text = Path(path).read_text(encoding="utf-8")
        fm, body = split_frontmatter(text)
        if fm is None or body is None:
            print(f"SKIP {path}: no frontmatter")
            continue

        repaired = repair_body(body)
        desc = first_paragraph(repaired)
        changes = []

        # Guard against cosmetic churn: repair_body normalizes leading/trailing
        # newlines, so a post that merely lacks a trailing newline at EOF would
        # otherwise diff and trigger a spurious "leak repair" (rebuild + deploy
        # + Cloudflare purge + Telegram notification). Only a REAL content fix
        # should count as a change.
        if body != repaired and body.strip("\n") == repaired.strip("\n"):
            print(f"SKIP {path}: cosmetic newline-only difference")
            continue

        # --- description fix ---
        new_fm = fm
        desc_match = re.search(r"(?m)^description:.*(?:\n  .*)*$", new_fm)
        if desc_match and "```" in desc_match.group(0):
            new_fm = re.sub(
                r"(?m)^description:.*(?:\n  .*)*$",
                "description: >-\n  " + (desc or "Daily thoughts on tech, science & culture"),
                new_fm,
                count=1,
            )
            changes.append("desc")

        # --- title fix ---
        tm = re.search(r'(?m)^title:\s*"(.*)"\s*$', new_fm)
        if tm and tm.group(1).strip() in ("Untitled Post", ""):
            new_title = first_heading(repaired)
            if new_title:
                escaped_title = new_title.replace('"', '\\"')
                new_fm = re.sub(
                    r'(?m)^title:\s*".*"\s*$',
                    f'title: "{escaped_title}"',
                    new_fm,
                    count=1,
                )
                changes.append("title")

        if body != repaired:
            changes.append("body")

        if not changes:
            continue

        out = f"---\n{new_fm}\n---\n\n{repaired}"
        Path(path).write_text(out, encoding="utf-8")
        changed += 1
        print(f"FIXED {Path(path).name}: {', '.join(changes)}")

    print(f"\n{changed} file(s) repaired out of {len(files)}")


if __name__ == "__main__":
    sys.exit(main())
