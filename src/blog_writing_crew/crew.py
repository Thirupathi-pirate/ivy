from crewai import Agent, Crew, LLM, Process, Task
from crewai.project import CrewBase, agent, crew, task
from blog_writing_crew.tools.custom_tool import NewsSearchTool

from typing import List
from crewai.agents.agent_builder.base_agent import BaseAgent


@CrewBase
class BlogWritingCrew():
    """Blog Writing Crew with live web research"""

    agents: List[BaseAgent]
    tasks: List[Task]

    agents_config = "config/agents.yaml"
    tasks_config = "config/tasks.yaml"

    _llm = LLM(model="google/gemini-2.0-flash")

    @agent
    def news_researcher(self) -> Agent:
        return Agent(
            config=self.agents_config["news_researcher"],  # type: ignore[index]
            tools=[NewsSearchTool()],
            llm=self._llm,
            verbose=True,
        )

    @agent
    def data_analyst(self) -> Agent:
        return Agent(
            config=self.agents_config["data_analyst"],  # type: ignore[index]
            llm=self._llm,
            verbose=True,
        )

    @agent
    def writer(self) -> Agent:
        return Agent(
            config=self.agents_config["writer"],  # type: ignore[index]
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
    def news_research_task(self) -> Task:
        return Task(
            config=self.tasks_config["news_research_task"],  # type: ignore[index]
        )

    @task
    def analysis_task(self) -> Task:
        return Task(
            config=self.tasks_config["analysis_task"],  # type: ignore[index]
            context=[self.news_research_task()],
        )

    @task
    def writing_task(self) -> Task:
        return Task(
            config=self.tasks_config["writing_task"],  # type: ignore[index]
            context=[self.analysis_task()],
        )

    @task
    def editing_task(self) -> Task:
        return Task(
            config=self.tasks_config["editing_task"],  # type: ignore[index]
            context=[self.writing_task()],
            output_file="output/blog_post.md",
        )

    @crew
    def crew(self) -> Crew:
        return Crew(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.sequential,
            verbose=True,
        )
