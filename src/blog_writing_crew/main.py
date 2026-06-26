#!/usr/bin/env python
import os
import sys
import warnings

from datetime import datetime
from pathlib import Path

from blog_writing_crew.crew import BlogWritingCrew

warnings.filterwarnings("ignore", category=SyntaxWarning, module="pysbd")


def run():
    """
    Run the crew with retry on Gemini 5xx errors.
    """
    inputs = {
        'topic': os.getenv("TOPIC", "The Future of AI Agents"),
        'current_year': str(datetime.now().year)
    }

    import time
    max_retries = 3
    result = None
    for attempt in range(1, max_retries + 1):
        try:
            result = BlogWritingCrew().crew().kickoff(inputs=inputs)
            break
        except Exception as e:
            err_str = str(e)
            if attempt < max_retries and ("500" in err_str or "INTERNAL" in err_str or "503" in err_str):
                wait = 2 ** attempt * 30
                print(f"Gemini API error (attempt {attempt}/{max_retries}), retrying in {wait}s: {e}")
                time.sleep(wait)
            else:
                raise Exception(f"An error occurred while running the crew: {e}")

    raw = result.raw if hasattr(result, "raw") else str(result)
    output_dir = Path(__file__).resolve().parent.parent.parent / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "blog_post.md").write_text(raw, encoding="utf-8")


def train():
    """
    Train the crew for a given number of iterations.
    """
    inputs = {
        "topic": "AI LLMs",
        'current_year': str(datetime.now().year)
    }
    try:
        BlogWritingCrew().crew().train(n_iterations=int(sys.argv[1]), filename=sys.argv[2], inputs=inputs)

    except Exception as e:
        raise Exception(f"An error occurred while training the crew: {e}")

def replay():
    """
    Replay the crew execution from a specific task.
    """
    try:
        BlogWritingCrew().crew().replay(task_id=sys.argv[1])

    except Exception as e:
        raise Exception(f"An error occurred while replaying the crew: {e}")

def test():
    """
    Test the crew execution and returns the results.
    """
    inputs = {
        "topic": "AI LLMs",
        "current_year": str(datetime.now().year)
    }

    try:
        BlogWritingCrew().crew().test(n_iterations=int(sys.argv[1]), eval_llm=sys.argv[2], inputs=inputs)

    except Exception as e:
        raise Exception(f"An error occurred while testing the crew: {e}")

def run_with_trigger():
    """
    Run the crew with trigger payload.
    """
    import json

    if len(sys.argv) < 2:
        raise Exception("No trigger payload provided. Please provide JSON payload as argument.")

    try:
        trigger_payload = json.loads(sys.argv[1])
    except json.JSONDecodeError:
        raise Exception("Invalid JSON payload provided as argument")

    inputs = {
        "crewai_trigger_payload": trigger_payload,
        "topic": "",
        "current_year": ""
    }

    try:
        result = BlogWritingCrew().crew().kickoff(inputs=inputs)
        return result
    except Exception as e:
        raise Exception(f"An error occurred while running the crew with trigger: {e}")

