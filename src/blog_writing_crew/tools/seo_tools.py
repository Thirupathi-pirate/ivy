import json
import re
from collections import Counter
from typing import ClassVar
from crewai.tools import BaseTool
from pydantic import BaseModel, Field


# ── Shared constants (module-level to avoid Pydantic issues) ─────────

STOP_WORDS = frozenset({
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "this", "that", "these",
    "those", "it", "its", "not", "no", "if", "then", "than", "too",
    "very", "just", "about", "also", "how", "what", "when", "where",
    "which", "who", "whom", "why", "all", "each", "every", "both",
    "few", "more", "most", "other", "some", "such", "only", "own",
    "same", "so", "as", "into", "through", "during", "before", "after",
    "above", "below", "between", "out", "off", "over", "under", "again",
    "further", "then", "once", "here", "there", "because", "while",
    "until", "although", "however", "like", "well", "still", "even",
    "new", "one", "two", "first", "last", "long", "great", "little",
    "right", "big", "high", "old", "different", "next", "small",
    "large", "important", "another", "certain", "during", "getting",
})

CATEGORY_MAP = {
    "ai": ["artificial-intelligence", "machine-learning"],
    "ml": ["machine-learning", "deep-learning"],
    "llm": ["large-language-models", "nlp"],
    "python": ["programming", "python"],
    "javascript": ["programming", "javascript"],
    "typescript": ["programming", "typescript"],
    "react": ["frontend", "react", "javascript"],
    "vue": ["frontend", "vue", "javascript"],
    "angular": ["frontend", "angular", "typescript"],
    "node": ["backend", "nodejs", "javascript"],
    "docker": ["devops", "containers", "docker"],
    "kubernetes": ["devops", "kubernetes"],
    "aws": ["cloud", "aws"],
    "gcp": ["cloud", "google-cloud"],
    "azure": ["cloud", "azure"],
    "cybersecurity": ["security", "cybersecurity"],
    "privacy": ["security", "privacy"],
    "blockchain": ["blockchain", "web3"],
    "crypto": ["cryptocurrency", "blockchain"],
    "bitcoin": ["cryptocurrency", "bitcoin"],
    "climate": ["environment", "climate"],
    "health": ["health", "wellness"],
    "space": ["space", "astronomy"],
    "nasa": ["space", "nasa"],
    "gaming": ["gaming", "entertainment"],
    "apple": ["apple", "technology"],
    "google": ["google", "technology"],
    "microsoft": ["microsoft", "technology"],
    "nvidia": ["nvidia", "hardware", "gpu"],
    "tesla": ["tesla", "electric-vehicles"],
    "ev": ["electric-vehicles", "sustainability"],
    "solar": ["renewable-energy", "sustainability"],
}


# ── SEO Analysis ──────────────────────────────────────────────────────

class SEOAnalysisInput(BaseModel):
    content: str = Field(..., description="The blog post content to analyze for SEO")
    target_keyword: str = Field(default="", description="Target keyword to analyze density for (auto-detected if empty)")


class SEOAnalysisTool(BaseTool):
    name: str = "seo_analysis"
    description: str = (
        "Analyzes blog post content for SEO quality: keyword density, "
        "header hierarchy, meta description quality, internal/external links, "
        "readability score. Returns a JSON report with actionable recommendations."
    )
    args_schema: type[BaseModel] = SEOAnalysisInput

    def _run(self, content: str, target_keyword: str = "") -> str:
        words = content.split()
        word_count = len(words)
        if word_count == 0:
            return json.dumps({"error": "Empty content"})

        # Auto-detect keyword if not provided
        if not target_keyword:
            target_keyword = self._detect_keyword(content)

        # Keyword density
        keyword_lower = target_keyword.lower()
        keyword_count = content.lower().count(keyword_lower)
        keyword_density = (keyword_count / word_count) * 100 if word_count else 0

        # Header analysis
        h1 = len(re.findall(r"^#\s+", content, re.MULTILINE))
        h2 = len(re.findall(r"^##\s+", content, re.MULTILINE))
        h3 = len(re.findall(r"^###\s+", content, re.MULTILINE))

        # Link analysis
        inline_links = len(re.findall(r"\[([^\]]+)\]\((https?://[^)]+)\)", content))
        bare_urls = len(re.findall(r"(?<!\()(https?://[^\s\)]+)", content))

        # Readability
        sentences = re.split(r"[.!?]+", content)
        sentences = [s.strip() for s in sentences if s.strip()]
        avg_words_per_sentence = word_count / len(sentences) if sentences else 0

        # Scoring
        score = 100
        recommendations = []

        # Keyword checks
        if keyword_density < 0.5:
            score -= 15
            recommendations.append(f"Keyword '{target_keyword}' density too low ({keyword_density:.2f}%), aim for 1-2%")
        elif keyword_density > 3.0:
            score -= 10
            recommendations.append(f"Keyword '{target_keyword}' density too high ({keyword_density:.2f}%), may be keyword stuffing")
        elif keyword_density < 1.0:
            score -= 5
            recommendations.append(f"Keyword '{target_keyword}' density low ({keyword_density:.2f}%), consider adding a few more mentions")

        # Header checks
        if h1 == 0:
            score -= 10
            recommendations.append("Missing H1 title header")
        elif h1 > 1:
            score -= 5
            recommendations.append("Multiple H1 headers — use only one")
        if h2 < 3:
            score -= 10
            recommendations.append(f"Only {h2} H2 sections — aim for 5+ for better structure")
        if h3 < 2:
            score -= 5
            recommendations.append("Consider adding H3 subsections for deeper content")

        # Link checks
        if inline_links < 5:
            score -= 15
            recommendations.append(f"Only {inline_links} inline links — aim for 10-15 for SEO")
        elif inline_links < 10:
            score -= 5
            recommendations.append(f"Only {inline_links} inline links — aim for 10-15")

        # Readability
        if avg_words_per_sentence > 25:
            score -= 10
            recommendations.append(f"Sentences too long (avg {avg_words_per_sentence:.0f} words) — aim for 15-20")
        elif avg_words_per_sentence < 8:
            score -= 5
            recommendations.append("Sentences too short — may read choppy")

        # Word count
        if word_count < 1500:
            score -= 15
            recommendations.append(f"Only {word_count} words — aim for 2500+")
        elif word_count < 2500:
            score -= 5
            recommendations.append(f"{word_count} words — consider expanding to 2500+")

        score = max(0, min(100, score))

        report = {
            "seo_score": score,
            "target_keyword": target_keyword,
            "keyword_density": f"{keyword_density:.2f}%",
            "keyword_occurrences": keyword_count,
            "word_count": word_count,
            "headers": {"h1": h1, "h2": h2, "h3": h3},
            "links": {"inline": inline_links, "bare_urls": bare_urls},
            "readability": {
                "avg_words_per_sentence": round(avg_words_per_sentence, 1),
                "sentence_count": len(sentences),
            },
            "grade": "A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60 else "D" if score >= 40 else "F",
            "recommendations": recommendations,
        }
        return json.dumps(report, indent=2)

    def _detect_keyword(self, content: str) -> str:
        words = content.lower().split()
        freq = Counter()
        for w in words:
            w_clean = re.sub(r"[^a-z0-9]", "", w)
            if len(w_clean) > 4 and w_clean not in STOP_WORDS and w_clean.isalpha():
                freq[w_clean] += 1
        if freq:
            return freq.most_common(1)[0][0]
        return "content"


# ── Content Quality Analysis ──────────────────────────────────────────

class ContentAnalysisInput(BaseModel):
    content: str = Field(..., description="The blog post content to analyze for quality")


class ContentAnalysisTool(BaseTool):
    name: str = "content_analysis"
    description: str = (
        "Analyzes blog post content quality: word count, paragraph structure, "
        "source attribution, inline links, visual formatting (emoji, bold, lists, "
        "blockquotes, mermaid diagrams). Returns a JSON report."
    )
    args_schema: type[BaseModel] = ContentAnalysisInput

    def _run(self, content: str) -> str:
        words = content.split()
        word_count = len(words)

        # Paragraphs
        paragraphs = [p.strip() for p in content.split("\n\n") if p.strip()]
        paragraphs = [p for p in paragraphs if not p.startswith("#") and not p.startswith("```")]

        # Sentences
        sentences = re.split(r"[.!?]+", content)
        sentences = [s.strip() for s in sentences if s.strip()]

        # Formatting elements
        emoji_count = len(re.findall(r"[\U0001F300-\U0001F9FF]", content))
        bold_count = len(re.findall(r"\*\*[^*]+\*\*", content))
        blockquote_count = len(re.findall(r"^>\s+", content, re.MULTILINE))
        bullet_list_items = len(re.findall(r"^[-*]\s+", content, re.MULTILINE))
        numbered_list_items = len(re.findall(r"^\d+\.\s+", content, re.MULTILINE))
        mermaid_blocks = len(re.findall(r"```mermaid", content))
        code_blocks = len(re.findall(r"```(?!mermaid)", content))

        # Links
        inline_links = len(re.findall(r"\[([^\]]+)\]\((https?://[^)]+)\)", content))
        source_urls = set(re.findall(r"https?://[^\s\)>\"']+", content))

        # Source attribution
        source_refs = len(re.findall(r"(?:according to|source:|cited|reference|\[.*?\]\(https?://)", content, re.IGNORECASE))

        # Structure
        sections = len(re.findall(r"^##\s+", content, re.MULTILINE))

        # Quality score
        score = 100
        issues = []

        if word_count < 2500:
            score -= 20
            issues.append(f"Word count {word_count} is below 2500 minimum")
        if inline_links < 5:
            score -= 15
            issues.append(f"Only {inline_links} inline links — need 10+")
        if emoji_count == 0:
            score -= 5
            issues.append("No emoji in headers — use them for visual scannability")
        if bold_count < 3:
            score -= 5
            issues.append("Few bold terms — bold key stats and terms")
        if blockquote_count == 0:
            score -= 5
            issues.append("No blockquotes — use for key quotes or takeaways")
        if mermaid_blocks == 0:
            score -= 5
            issues.append("No mermaid diagram — add a flow/chart diagram")
        if bullet_list_items == 0 and numbered_list_items == 0:
            score -= 5
            issues.append("No lists — use bullets or numbered lists for scannability")
        if sections < 5:
            score -= 10
            issues.append(f"Only {sections} sections — aim for 8+")
        if len(paragraphs) < 10:
            score -= 5
            issues.append(f"Only {len(paragraphs)} paragraphs — content feels thin")

        score = max(0, min(100, score))

        report = {
            "quality_score": score,
            "word_count": word_count,
            "paragraph_count": len(paragraphs),
            "sentence_count": len(sentences),
            "section_count": sections,
            "formatting": {
                "emoji_headers": emoji_count,
                "bold_terms": bold_count,
                "blockquotes": blockquote_count,
                "bullet_items": bullet_list_items,
                "numbered_items": numbered_list_items,
                "mermaid_diagrams": mermaid_blocks,
                "code_blocks": code_blocks,
            },
            "links": {
                "inline_links": inline_links,
                "unique_urls": len(source_urls),
            },
            "source_attribution_refs": source_refs,
            "grade": "A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60 else "D" if score >= 40 else "F",
            "issues": issues,
        }
        return json.dumps(report, indent=2)


# ── Tag Extraction ────────────────────────────────────────────────────

class TagExtractionInput(BaseModel):
    content: str = Field(..., description="The blog post content to extract tags from")
    max_tags: int = Field(default=8, description="Maximum number of tags to generate")


class TagExtractionTool(BaseTool):
    name: str = "extract_tags"
    description: str = (
        "Extracts relevant tags from blog post content for Jekyll/Chirpy frontmatter. "
        "Returns a JSON array of lowercase kebab-case tags suitable for YAML frontmatter."
    )
    args_schema: type[BaseModel] = TagExtractionInput

    def _run(self, content: str, max_tags: int = 8) -> str:
        content_lower = content.lower()

        # Extract frequent meaningful words
        words = re.findall(r"[a-z0-9]+(?:[-'][a-z0-9]+)*", content_lower)
        freq = Counter()
        for w in words:
            if len(w) > 3 and w not in STOP_WORDS:
                freq[w] += 1

        # Get candidate tags from high-frequency words
        candidates = [w for w, _ in freq.most_common(30)]

        # Check category hints
        tags = set()
        for word in candidates:
            if word in CATEGORY_MAP:
                for tag in CATEGORY_MAP[word]:
                    tags.add(tag)

        # Add top frequent words as tags (kebab-case)
        for word in candidates:
            if len(tags) >= max_tags:
                break
            if word not in STOP_WORDS and len(word) > 3:
                tags.add(word)

        # Extract from headers
        headers = re.findall(r"^#{1,3}\s+(.+)$", content, re.MULTILINE)
        for header in headers:
            if len(tags) >= max_tags:
                break
            # Clean header to tag
            tag = re.sub(r"[^a-z0-9\s-]", "", header.lower())
            tag = re.sub(r"\s+", "-", tag.strip())
            if tag and len(tag) > 3 and tag not in STOP_WORDS:
                tags.add(tag)

        # Limit and sort
        tag_list = sorted(tags)[:max_tags]

        return json.dumps(tag_list)
