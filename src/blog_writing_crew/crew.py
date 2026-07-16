from crewai import Agent, Crew, LLM, Process, Task
from crewai.project import CrewBase, agent, crew, task
from blog_writing_crew.tools.custom_tool import (
    NewsSearchTool,
    WikipediaSearchTool,
    HackerNewsSearchTool,
    ArXivSearchTool,
    OpenLibrarySearchTool,
    RSSFeedTool,
)
from blog_writing_crew.tools.seo_tools import (
    SEOAnalysisTool,
    ContentAnalysisTool,
    TagExtractionTool,
)

try:
    from crewai.agents.agent_builder.base_agent import BaseAgent
except ImportError:
    from crewai import Agent as BaseAgent  # type: ignore[assignment]

from typing import List
import time
import logging

logger = logging.getLogger(__name__)

# Delay between tasks to avoid hitting Gemini free tier rate limit (16K tokens/min)
TASK_DELAY_SECONDS = 45


def _task_delay_callback(output):
    """Called after each task completes — adds delay to let rate limit reset."""
    logger.info(f"Task completed. Waiting {TASK_DELAY_SECONDS}s for rate limit reset...")
    print(f"\n⏳ Task done. Waiting {TASK_DELAY_SECONDS}s for API rate limit reset...\n")
    time.sleep(TASK_DELAY_SECONDS)


@CrewBase
class BlogWritingCrew():
    """Blog Writing Crew — research + humanised writing + SEO + quality"""

    agents: List[BaseAgent]
    tasks: List[Task]

    agents_config = "config/agents.yaml"
    tasks_config = "config/tasks.yaml"

    _llm = LLM(model="gemini-2.5-flash", max_tokens=32768, timeout=300) #WR

    @agent
    def writer(self) -> Agent:
        return Agent(
            config=self.agents_config["writer"],
            tools=[
                NewsSearchTool(),
                WikipediaSearchTool(),
                HackerNewsSearchTool(),
                ArXivSearchTool(),
                OpenLibrarySearchTool(),
                RSSFeedTool(),
            ],
            llm=self._llm,
            verbose=True,
            max_retry_limit=3,
        )

    @agent
    def humaniser(self) -> Agent:
        return Agent(
            config=self.agents_config["humaniser"],
            llm=self._llm,
            verbose=True,
            max_retry_limit=3,
        )

    @agent
    def editor(self) -> Agent:
        return Agent(
            config=self.agents_config["editor"],
            llm=self._llm,
            verbose=True,
            max_retry_limit=3,
        )

    @agent
    def seo_optimizer(self) -> Agent:
        return Agent(
            config=self.agents_config["seo_optimizer"],
            tools=[SEOAnalysisTool(), TagExtractionTool()],
            llm=self._llm,
            verbose=True,
            max_retry_limit=3,
        )

    @agent
    def quality_reviewer(self) -> Agent:
        return Agent(
            config=self.agents_config["quality_reviewer"],
            tools=[ContentAnalysisTool(), SEOAnalysisTool()],
            llm=self._llm,
            verbose=True,
            max_retry_limit=3,
        )

    @task
    def planning_task(self) -> Task:
        return Task(
            config=self.tasks_config["planning_task"],
            timeout=300,
        )

    @task
    def writing_task(self) -> Task:
        return Task(
            config=self.tasks_config["writing_task"],
            context=[self.planning_task()],
            timeout=900,
        )

    @task
    def humanising_task(self) -> Task:
        return Task(
            config=self.tasks_config["humanising_task"],
            context=[self.writing_task()],
            timeout=600,
        )

    @task
    def editing_task(self) -> Task:
        return Task(
            config=self.tasks_config["editing_task"],
            context=[self.humanising_task()],
            timeout=1200,
        )

    @task
    def seo_task(self) -> Task:
        return Task(
            config=self.tasks_config["seo_task"],
            context=[self.editing_task()],
            timeout=600,
        )

    @task
    def quality_task(self) -> Task:
        return Task(
            config=self.tasks_config["quality_task"],
            context=[self.seo_task()],
            timeout=600,
        )

    @crew
    def crew(self) -> Crew:
        return Crew(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.sequential,
            step_callback=_task_delay_callback,
            verbose=True,
        )

    def kickoff_with_retry(self, inputs=None, max_retries=5):
        """Run crew with exponential backoff on rate limit errors."""
        for attempt in range(max_retries):
            try:
                return self.crew().kickoff(inputs=inputs)
            except Exception as e:
                error_msg = str(e).lower()
                is_rate_limit = any(x in error_msg for x in ["429", "rate", "quota", "resource_exhausted"])
                if is_rate_limit and attempt < max_retries - 1:
                    wait_time = min(90 * (2 ** attempt), 600)
                    logger.warning(f"Rate limited (attempt {attempt + 1}/{max_retries}). Waiting {wait_time}s...")
                    print(f"\n⏳ Rate limited. Retrying in {wait_time}s... (attempt {attempt + 1}/{max_retries})\n")
                    time.sleep(wait_time)
                else:
                    raise
