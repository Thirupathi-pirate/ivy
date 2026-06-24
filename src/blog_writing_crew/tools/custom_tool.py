from crewai.tools import BaseTool
from typing import Type
from pydantic import BaseModel, Field
from camoufox.sync_api import Camoufox
from ddgs import DDGS
from bs4 import BeautifulSoup
from datetime import datetime
import logging

logging.getLogger("camoufox").setLevel(logging.WARNING)
logging.getLogger("ddgs").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)


class NewsSearchInput(BaseModel):
    """Input schema for NewsSearchTool."""
    query: str = Field(..., description="The search query to find news about")
    max_sources: int = Field(default=5, description="Maximum number of sources to scrape")


class NewsSearchTool(BaseTool):
    name: str = "news_search"
    description: str = (
        "Searches the web for the latest news and articles on a given topic. "
        "Uses DuckDuckGo search and extracts full article content via a headless browser. "
        "Returns compiled research with source URLs and key information."
    )
    args_schema: Type[BaseModel] = NewsSearchInput

    def _search(self, query: str, max_sources: int) -> list[dict]:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_sources))
        return [
            {"title": r.get("title", ""), "url": r.get("href", ""), "body": r.get("body", "")}
            for r in results if r.get("href")
        ]

    def _scrape(self, url: str) -> tuple[str, str]:
        with Camoufox() as browser:
            context = browser.new_context()
            context.set_default_timeout(25000)
            page = context.new_page()
            page.on("pageerror", lambda err: logger.debug(f"Page error: {err}"))

            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_timeout(2000)

            html = page.content()
            soup = BeautifulSoup(html, "lxml")
            for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
                tag.decompose()

            title_tag = soup.find("title")
            title = title_tag.get_text(strip=True) if title_tag else "No title"

            text = soup.get_text(separator="\n", strip=True)
            lines = [l for l in text.split("\n") if len(l.strip()) > 40]
            content = "\n".join(lines[:60])

            page.close()
            context.close()

        return title, content

    def _run(self, query: str, max_sources: int = 5) -> str:
        results = []

        try:
            sources = self._search(query, max_sources)
            if not sources:
                return "No search results found."

            results.append(f"## News Research Results\n**Query:** {query}\n\n")
            results.append(f"Found {len(sources)} sources. Extracting content...\n---\n")

            for src in sources:
                url = src["url"]
                title = src.get("title", "No title")
                snippet = src.get("body", "")[:200]

                results.append(f"🔗 **{title}**")
                results.append(f"   URL: {url}")
                if snippet:
                    results.append(f"   Snippet: {snippet}")

                try:
                    full_title, content = self._scrape(url)
                    if content:
                        results.append(f"\n{content}\n")
                    else:
                        results.append("   (No additional content extracted)\n")
                except Exception as e:
                    results.append(f"   (Scrape skipped: {e})\n")

                results.append("---\n")
        except Exception as e:
            return f"Search failed: {e}"

        return "\n".join(results)
