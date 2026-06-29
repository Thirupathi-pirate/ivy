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

try:
    from crewai.agents.agent_builder.base_agent import BaseAgent
except ImportError:
    from crewai import Agent as BaseAgent  # type: ignore[assignment]

from typing import List


@CrewBase
class BlogWritingCrew():
    """Blog Writing Crew — Camoufox research + humanised writing"""

    agents: List[BaseAgent]
    tasks: List[Task]

    agents_config = "config/agents.yaml"
    tasks_config = "config/tasks.yaml"

    _llm = LLM(model="google/gemma-4-31b-it", max_tokens=32768, timeout=300)

    @agent
    def writer(self) -> Agent:
        return Agent(
            config=self.agents_config["writer"],  # type: ignore[index]
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
        )

    @agent
    def humaniser(self) -> Agent:
        return Agent(
            config=self.agents_config["humaniser"],  # type: ignore[index]
            llm=self._llm,
            verbose=True,
        )

    @agent
    def editor(self) -> Agent:
        return Agent(
            config=self.agents_config["editor"],  # type: ignore[index]
            llm=self._llm,
            verbose=True,
        )

    @task
    def writing_task(self) -> Task:
        return Task(
            config=self.tasks_config["writing_task"],  # type: ignore[index]
            timeout=900,
        )

    @task
    def humanising_task(self) -> Task:
        return Task(
            config=self.tasks_config["humanising_task"],  # type: ignore[index]
            context=[self.writing_task()],
            timeout=600,
        )

    @task
    def editing_task(self) -> Task:
        return Task(
            config=self.tasks_config["editing_task"],  # type: ignore[index]
            context=[self.humanising_task()],
            timeout=1200,
        )

    @crew
    def crew(self) -> Crew:
        return Crew(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.sequential,
            verbose=True,
        )
