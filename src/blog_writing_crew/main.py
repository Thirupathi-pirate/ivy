#!/usr/bin/env python
import os
import sys
import warnings

from datetime import datetime
from pathlib import Path

from blog_writing_crew.crew import BlogWritingCrew

warnings.filterwarnings("ignore", category=SyntaxWarning, module="pysbd")


def run():
    """Run the crew with retry on rate limit / 5xx errors."""
    inputs = {
        "topic": os.getenv("TOPIC", "The Future of AI Agents"),
        "current_year": str(datetime.now().year),
    }

    result = BlogWritingCrew().kickoff_with_retry(inputs=inputs, max_retries=5)

    raw = result.raw if hasattr(result, "raw") else str(result)
    output_dir = Path(__file__).resolve().parent.parent.parent / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "blog_post.md").write_text(raw, encoding="utf-8")
    print(f"\n✅ Blog post saved to output/blog_post.md ({len(raw)} chars)")


def train():
    """Train the crew for a given number of iterations."""
    inputs = {
        "topic": os.getenv("TOPIC", "The Future of AI Agents"),
        "current_year": str(datetime.now().year),
    }
    if len(sys.argv) < 3:
        raise Exception("Usage: crewai train <n_iterations> <filename>")
    BlogWritingCrew().crew().train(n_iterations=int(sys.argv[1]), filename=sys.argv[2], inputs=inputs)


def replay():
    """Replay the crew execution from a specific task."""
    if len(sys.argv) < 2:
        raise Exception("Usage: crewai replay <task_id>")
    BlogWritingCrew().crew().replay(task_id=sys.argv[1])


def test():
    """Test the crew execution."""
    inputs = {
        "topic": os.getenv("TOPIC", "The Future of AI Agents"),
        "current_year": str(datetime.now().year),
    }
    if len(sys.argv) < 3:
        raise Exception("Usage: crewai test <n_iterations> <eval_llm>")
    BlogWritingCrew().crew().test(n_iterations=int(sys.argv[1]), eval_llm=sys.argv[2], inputs=inputs)


def run_with_trigger():
    """Run the crew with trigger payload."""
    import json

    if len(sys.argv) < 2:
        raise Exception("No trigger payload provided.")
    trigger_payload = json.loads(sys.argv[1])
    inputs = {
        "crewai_trigger_payload": trigger_payload,
        "topic": trigger_payload.get("topic", ""),
        "current_year": str(datetime.now().year),
    }
    return BlogWritingCrew().kickoff_with_retry(inputs=inputs, max_retries=5)
