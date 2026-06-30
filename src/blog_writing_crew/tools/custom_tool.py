import os
import logging
from crewai.tools import BaseTool
from typing import Type
from pydantic import BaseModel, Field
from tavily import TavilyClient
import requests
import feedparser
from xml.etree import ElementTree

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


class WikipediaSearchInput(BaseModel):
    query: str = Field(..., description="The topic to search for on Wikipedia")


class WikipediaSearchTool(BaseTool):
    name: str = "wikipedia_search"
    description: str = (
        "Searches Wikipedia for factual information on a given topic. "
        "Returns article titles, summaries, and URLs. "
        "Use this for factual ground truth, definitions, history, and background on any topic."
    )
    args_schema: Type[BaseModel] = WikipediaSearchInput

    _session: requests.Session | None = None

    def _get_session(self) -> requests.Session:
        if self._session is None:
            self._session = requests.Session()
            self._session.headers.update({"User-Agent": "IvyBlogBot/1.0 (crewai blog writer)"})
        return self._session

    def _run(self, query: str) -> str:
        session = self._get_session()
        output = [f"## Wikipedia Results\n**Query:** {query}\n---\n"]

        try:
            r = session.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "query",
                    "list": "search",
                    "srsearch": query,
                    "format": "json",
                    "srlimit": 5,
                    "srprop": "snippet|titlesnippet",
                },
                timeout=10,
            )
            r.raise_for_status()
            data = r.json()
            search_results = data.get("query", {}).get("search", [])
            if not search_results:
                return f"## Wikipedia Results\n**Query:** {query}\n\nNo results found on Wikipedia."

            for i, result in enumerate(search_results[:3], 1):
                title = result.get("title", "Unknown")
                snippet = result.get("snippet", "")
                snippet = snippet.replace("<span class=\"searchmatch\">", "**").replace("</span>", "**")

                output.append(f"### {i}. {title}")
                output.append(f"**Snippet:** {snippet}")
                output.append(f"**URL:** https://en.wikipedia.org/wiki/{title.replace(' ', '_')}")

                summary_r = session.get(
                    f"https://en.wikipedia.org/api/rest_v1/page/summary/{title.replace(' ', '_')}",
                    timeout=10,
                )
                if summary_r.status_code == 200:
                    summary_data = summary_r.json()
                    extract = summary_data.get("extract", "")
                    if extract:
                        output.append(f"\n{extract[:1500]}\n")
                output.append("---\n")

        except Exception as e:
            return f"## Wikipedia Results\n**Query:** {query}\n\nError fetching Wikipedia: {e}"

        return "\n".join(output)


class HackerNewsSearchInput(BaseModel):
    query: str = Field(..., description="The topic to search for on Hacker News")


class HackerNewsSearchTool(BaseTool):
    name: str = "hackernews_search"
    description: str = (
        "Searches Hacker News via Algolia for community discussions and stories on a given topic. "
        "Returns story titles, URLs, points, author, and comment counts. "
        "Use this for tech community insights, real developer opinions, and trending discussions."
    )
    args_schema: Type[BaseModel] = HackerNewsSearchInput

    def _run(self, query: str) -> str:
        output = [f"## Hacker News Results\n**Query:** {query}\n---\n"]

        try:
            r = requests.get(
                "https://hn.algolia.com/api/v1/search",
                params={"query": query, "hitsPerPage": 10, "tags": "story"},
                timeout=10,
                headers={"User-Agent": "IvyBlogBot/1.0"},
            )
            r.raise_for_status()
            data = r.json()
            hits = data.get("hits", [])

            if not hits:
                return f"## Hacker News Results\n**Query:** {query}\n\nNo stories found."

            for i, hit in enumerate(hits, 1):
                title = hit.get("title", "No title")
                url = hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID', '')}"
                points = hit.get("points", 0)
                author = hit.get("author", "unknown")
                num_comments = hit.get("num_comments", 0)
                created_at = hit.get("created_at", "")

                output.append(f"### {i}. {title}")
                output.append(f"**URL:** {url}")
                output.append(f"**Points:** {points} | **Author:** {author} | **Comments:** {num_comments}")
                output.append(f"**Published:** {created_at}")
                output.append("---\n")

        except Exception as e:
            return f"## Hacker News Results\n**Query:** {query}\n\nError fetching Hacker News: {e}"

        return "\n".join(output)


class ArXivSearchInput(BaseModel):
    query: str = Field(..., description="The research topic to search for on ArXiv")
    max_results: int = Field(default=5, description="Maximum number of papers to return")


class ArXivSearchTool(BaseTool):
    name: str = "arxiv_search"
    description: str = (
        "Searches ArXiv for academic papers and research on a given topic. "
        "Returns paper titles, authors, publication dates, summaries, and links. "
        "Use this for academic research, scientific findings, and scholarly sources."
    )
    args_schema: Type[BaseModel] = ArXivSearchInput

    def _run(self, query: str, max_results: int = 5) -> str:
        output = [f"## ArXiv Research Results\n**Query:** {query}\n---\n"]

        try:
            r = requests.get(
                "http://export.arxiv.org/api/query",
                params={"search_query": f"all:{query}", "max_results": max_results, "sortBy": "relevance"},
                timeout=15,
                headers={"User-Agent": "IvyBlogBot/1.0"},
            )
            r.raise_for_status()

            root = ElementTree.fromstring(r.content)
            ns = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}

            entries = root.findall("atom:entry", ns)
            if not entries:
                return f"## ArXiv Research Results\n**Query:** {query}\n\nNo papers found."

            for i, entry in enumerate(entries, 1):
                title_el = entry.find("atom:title", ns)
                title = title_el.text.strip().replace("\n", " ") if title_el is not None and title_el.text else "No title"

                summary_el = entry.find("atom:summary", ns)
                summary = summary_el.text.strip().replace("\n", " ") if summary_el is not None and summary_el.text else ""

                published_el = entry.find("atom:published", ns)
                published = published_el.text[:10] if published_el is not None and published_el.text else ""

                link_el = entry.find("atom:id", ns)
                link = link_el.text.strip() if link_el is not None and link_el.text else ""

                authors = []
                for author_el in entry.findall("atom:author", ns):
                    name_el = author_el.find("atom:name", ns)
                    if name_el is not None and name_el.text:
                        authors.append(name_el.text.strip())
                author_str = ", ".join(authors) if authors else "Unknown"

                output.append(f"### {i}. {title}")
                output.append(f"**Authors:** {author_str}")
                output.append(f"**Published:** {published}")
                output.append(f"**URL:** {link}")
                if summary:
                    output.append(f"\n{summary[:800]}...\n")
                output.append("---\n")

        except Exception as e:
            return f"## ArXiv Research Results\n**Query:** {query}\n\nError fetching ArXiv: {e}"

        return "\n".join(output)


class OpenLibrarySearchInput(BaseModel):
    query: str = Field(..., description="The topic or book title to search for on Open Library")
    max_results: int = Field(default=5, description="Maximum number of books to return")


class OpenLibrarySearchTool(BaseTool):
    name: str = "openlibrary_search"
    description: str = (
        "Searches Open Library for books related to a given topic. "
        "Returns book titles, authors, publication years, subjects, and descriptions. "
        "Use this for book references, author information, and literary sources."
    )
    args_schema: Type[BaseModel] = OpenLibrarySearchInput

    def _run(self, query: str, max_results: int = 5) -> str:
        output = [f"## Open Library Results\n**Query:** {query}\n---\n"]

        try:
            r = requests.get(
                "https://openlibrary.org/search.json",
                params={"q": query, "limit": max_results},
                timeout=10,
                headers={"User-Agent": "IvyBlogBot/1.0"},
            )
            r.raise_for_status()
            data = r.json()
            docs = data.get("docs", [])

            if not docs:
                return f"## Open Library Results\n**Query:** {query}\n\nNo books found."

            for i, doc in enumerate(docs, 1):
                title = doc.get("title", "No title")
                authors = doc.get("author_name", ["Unknown"])
                year = doc.get("first_publish_year", "")
                subjects = doc.get("subject", [])[:5]
                isbn = doc.get("isbn", [])
                isbn_str = isbn[0] if isbn else ""

                output.append(f"### {i}. {title}")
                output.append(f"**Author(s):** {', '.join(authors)}")
                if year:
                    output.append(f"**First Published:** {year}")
                if subjects:
                    output.append(f"**Subjects:** {', '.join(subjects)}")
                if isbn_str:
                    output.append(f"**ISBN:** {isbn_str}")
                    output.append(f"**Open Library:** https://openlibrary.org/isbn/{isbn_str}")
                output.append("---\n")

        except Exception as e:
            return f"## Open Library Results\n**Query:** {query}\n\nError fetching Open Library: {e}"

        return "\n".join(output)


class RSSFeedInput(BaseModel):
    feed_url: str = Field(..., description="The RSS/Atom feed URL to fetch")
    max_items: int = Field(default=10, description="Maximum number of entries to return")


class RSSFeedTool(BaseTool):
    name: str = "rss_feed"
    description: str = (
        "Fetches and parses an RSS or Atom feed from a given URL. "
        "Returns recent entries with titles, links, publication dates, and summaries. "
        "Use this after finding a blog or news site via news_search to get their latest articles."
    )
    args_schema: Type[BaseModel] = RSSFeedInput

    def _run(self, feed_url: str, max_items: int = 10) -> str:
        output = [f"## RSS Feed Results\n**Feed URL:** {feed_url}\n---\n"]

        try:
            feed = feedparser.parse(feed_url)

            if feed.bozo and not feed.entries:
                return f"## RSS Feed Results\n**Feed URL:** {feed_url}\n\nFailed to parse feed (status: {feed.status})."

            if not feed.entries:
                return f"## RSS Feed Results\n**Feed URL:** {feed_url}\n\nNo entries found in feed."

            feed_title = feed.feed.get("title", "Untitled Feed")
            output.append(f"**Feed:** {feed_title}\n---\n")

            for i, entry in enumerate(feed.entries[:max_items], 1):
                title = entry.get("title", "No title")
                link = entry.get("link", "")
                published = entry.get("published", entry.get("updated", ""))
                summary = entry.get("summary", entry.get("description", ""))
                author = entry.get("author", "")

                output.append(f"### {i}. {title}")
                if author:
                    output.append(f"**Author:** {author}")
                output.append(f"**Published:** {published}")
                output.append(f"**Link:** {link}")
                if summary:
                    summary_clean = summary.replace("<p>", "").replace("</p>", "\n").replace("<br>", "\n").replace("<br/>", "\n")
                    output.append(f"\n{summary_clean[:500]}...\n")
                output.append("---\n")

        except Exception as e:
            return f"## RSS Feed Results\n**Feed URL:** {feed_url}\n\nError fetching RSS feed: {e}"

        return "\n".join(output)
