import os
import logging
from crewai.tools import BaseTool
from typing import Type
from pydantic import BaseModel, Field
from tavily import TavilyClient

logger = logging.getLogger(__name__)


class NewsSearchInput(BaseModel):
    query: str = Field(..., description="The search query to find news about")
    max_sources: int = Field(default=10, description="Maximum number of quality sources to collect")


class NewsSearchTool(BaseTool):
    name: str = "news_search"
    description: str = (
        "Searches the web for the latest news and articles on a given topic using Tavily. "
        "Fetches Google-quality results with full article content already extracted. "
        "Returns compiled research with source URLs and key information."
    )
    args_schema: Type[BaseModel] = NewsSearchInput

    _tavily: TavilyClient | None = None

    def _get_tavily(self) -> TavilyClient:
        if self._tavily is None:
            api_key = os.getenv("TAVILY_API_KEY")
            if not api_key:
                raise ValueError("TAVILY_API_KEY not set in environment")
            self._tavily = TavilyClient(api_key=api_key)
        return self._tavily

    def _run(self, query: str, max_sources: int = 10) -> str:
        client = self._get_tavily()

        try:
            response = client.search(
                query=query,
                max_results=20,
                search_depth="advanced",
                include_raw_content=True,
            )
        except Exception as e:
            return f"Tavily search failed: {e}"

        results = response.get("results", [])
        if not results:
            return f"No sources found for: {query}"

        articles = []
        for item in results:
            articles.append(item)

        articles.sort(key=lambda x: x.get("score", 0), reverse=True)
        top = [a for a in articles if a.get("score", 0) >= 0.8][:max_sources]
        if not top:
            top = articles[:max_sources]

        output = [f"## Web Research Results\n**Query:** {query}\n"]
        output.append(f"Selected {len(top)} sources:\n---\n")

        for i, item in enumerate(top, 1):
            title = item.get("title", "No title")
            url = item.get("url", "")
            body = item.get("raw_content") or item.get("content", "")

            output.append(f"### {i}. {title}")
            output.append(f"**Source:** {url}")
            if body:
                output.append(f"\n{body}\n")
            output.append("---\n")

        return "\n".join(output)
