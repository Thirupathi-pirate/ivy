import os
import logging
from crewai.tools import BaseTool
from crewai import LLM
from typing import Type, Optional
from pydantic import BaseModel, Field
from tavily import TavilyClient

logger = logging.getLogger(__name__)


class NewsSearchInput(BaseModel):
    query: str = Field(..., description="The search query to find news about")
    max_sources: int = Field(default=7, description="Maximum number of quality sources to collect")


class NewsSearchTool(BaseTool):
    name: str = "news_search"
    description: str = (
        "Searches the web for the latest news and articles on a given topic using Tavily. "
        "Fetches Google-quality results with full article content already extracted. "
        "Uses AI to rank results by relevance and quality, returning only the best sources. "
        "Returns compiled research with source URLs and key information."
    )
    args_schema: Type[BaseModel] = NewsSearchInput

    _llm: Optional[LLM] = None
    _tavily: Optional[TavilyClient] = None

    def _get_llm(self) -> LLM:
        if self._llm is None:
            self._llm = LLM(
                model=os.getenv("MODEL", "google/gemma-4-26b-a4b-it"),
                api_key=os.getenv("GEMINI_API_KEY"),
            )
        return self._llm

    def _get_tavily(self) -> TavilyClient:
        if self._tavily is None:
            api_key = os.getenv("TAVILY_API_KEY")
            if not api_key:
                raise ValueError("TAVILY_API_KEY not set in environment")
            self._tavily = TavilyClient(api_key=api_key)
        return self._tavily

    def _score_result(self, query: str, title: str, snippet: str, url: str) -> Optional[int]:
        prompt = f"""Score this search result for quality and relevance.

Search query: {query}
Title: {title}
URL: {url}
Snippet: {snippet[:300]}

Rate 0-10 based on:
- Relevance to the query (is this directly about the topic?)
- Source credibility (is it a reputable publication?)
- Content depth (does it seem like substantive content?)

Return ONLY a number 0-10."""
        try:
            resp = self._get_llm().call(prompt)
            text = resp.strip()
            # Extract number from response
            for token in text.split():
                try:
                    n = float(token)
                    return min(max(int(n), 0), 10)
                except ValueError:
                    continue
            return 5
        except Exception as e:
            logger.warning(f"LLM scoring failed: {e}")
            return 5

    def _run(self, query: str, max_sources: int = 7) -> str:
        client = self._get_tavily()
        scored_results = []
        page = 1
        max_pages = 3

        results_formatted = [f"## Web Research Results\n**Query:** {query}\n\n"]

        while len(scored_results) < max_sources and page <= max_pages:
            try:
                response = client.search(
                    query=query,
                    max_results=15,
                    search_depth="advanced",
                    include_raw_content=False,
                )
            except Exception as e:
                return f"Tavily search failed: {e}"

            raw_results = response.get("results", [])
            if not raw_results:
                break

            for item in raw_results:
                title = item.get("title", "")
                url = item.get("url", "")
                content = item.get("content", "")[:500]
                score = self._score_result(query, title, content, url)
                logger.info(f"  Score {score}/10 — {title[:60]}")

                if score >= 8:
                    scored_results.append(item)
                    if len(scored_results) >= max_sources:
                        break

            page += 1
            if len(scored_results) < max_sources and page <= max_pages:
                query = f"{query} (page {page})"

        if not scored_results:
            return f"No high-quality sources found for: {query}"

        results_formatted.append(f"Selected {len(scored_results)} high-quality sources:\n---\n")

        for i, item in enumerate(scored_results[:max_sources], 1):
            title = item.get("title", "No title")
            url = item.get("url", "")
            content = item.get("content", "")

            results_formatted.append(f"### {i}. {title}")
            results_formatted.append(f"**Source:** {url}")
            if content:
                results_formatted.append(f"\n{content}\n")
            results_formatted.append("---\n")

        return "\n".join(results_formatted)
