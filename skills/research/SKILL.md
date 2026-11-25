---
name: research
description: Research an explicit scientific or technical question, including an InternAgent discovery task that needs literature evidence.
argument-hint: "<research question>"
---

Research question: $ARGUMENTS

For a plain question, prepare a project-local InternAgent task folder with a `prompt.json` that records `task_description`, `domain`, `background`, and `constraints`. Preserve relevant local papers as evidence and include their paths in the background. Invoke the `internagent:run` Skill with `report <task-folder>` to use the upstream idea agents, literature tools, and memory. Summarize the result with direct citations where available, distinguishing evidence, hypotheses, and proposed experiments.

When the user explicitly asks for a standalone literature answer in Claude Code, use accessible primary sources, local papers, or enabled Claude Code web tools. Track title, URL or file, experimental setting, evidence and uncertainty. Search for contradictory evidence as well as promising approaches. State which claims the available sources support.
