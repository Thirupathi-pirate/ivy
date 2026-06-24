from crewai.tools import BaseTool
from typing import Type
from pydantic import BaseModel, Field
from playwright.sync_api import sync_playwright
from ddgs import DDGS
from bs4 import BeautifulSoup
from datetime import datetime
import logging

logging.getLogger("playwright").setLevel(logging.WARNING)
logging.getLogger("ddgs").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)


class NewsSearchInput(BaseModel):
    query: str = Field(..., description="The search query to find news about")
    max_sources: int = Field(default=5, description="Maximum number of sources to scrape")


class NewsSearchTool(BaseTool):
    name: str = "news_search"
    description: str = (
        "Searches the web for the latest news and articles on a given topic. "
        "Finds relevant sources and extracts full article content using a browser. "
        "Returns compiled research with source URLs and key information."
    )
    args_schema: Type[BaseModel] = NewsSearchInput

    def _run(self, query: str, max_sources: int = 5) -> str:
        results = []

        try:
            with DDGS() as ddgs:
                sources = list(ddgs.text(query, max_results=max_sources))

            if not sources:
                return "No search results found."

            results.append(f"## Web Research Results\n**Query:** {query}\n\n")
            results.append(f"Found {len(sources)} sources. Extracting content...\n---\n")

            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                ctx = browser.new_context(
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
                    )
                )
                ctx.set_default_timeout(25000)

                for src in sources:
                    url = src.get("href", "")
                    title = src.get("title", "No title")
                    snippet = src.get("body", "")[:200]

                    results.append(f"🔗 **{title}**")
                    results.append(f"   URL: {url}")
                    if snippet:
                        results.append(f"   Snippet: {snippet}")

                    if url:
                        try:
                            pg = ctx.new_page()
                            pg.goto(url, wait_until="domcontentloaded", timeout=20000)
                            pg.wait_for_timeout(1500)

                            html = pg.content()
                            soup = BeautifulSoup(html, "lxml")
                            for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
                                tag.decompose()

                            t = soup.find("title")
                            scraped_title = t.get_text(strip=True) if t else "No title"

                            text = soup.get_text(separator="\n", strip=True)
                            lines = [l for l in text.split("\n") if len(l.strip()) > 40]
                            content = "\n".join(lines[:60])

                            if content:
                                results.append(f"\n{content}\n")
                            pg.close()
                        except Exception as e:
                            results.append(f"   (Scrape skipped: {e})\n")

                    results.append("---\n")

                ctx.close()
                browser.close()
        except Exception as e:
            return f"Research failed: {e}"

        return "\n".join(results)
