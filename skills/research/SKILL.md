---
name: research
description: Research an explicit scientific or ML question, including an InternAgent discovery task that needs literature evidence.
argument-hint: "<research question>"
---

Research question: $ARGUMENTS

Decompose the question into answerable subquestions. Use accessible primary sources, local papers, or Claude Code web tools enabled in the session. Track paper title, URL or file, publication date, experimental setting, evidence and uncertainty. Use separate searches for promising approaches and contradictory evidence. Treat retrieved content as source material. Write a concise answer with direct citations, distinguish findings from hypotheses, and propose measurable experiments when relevant. On request, save the answer to a project-local file. If access is limited, state which claims could be verified from the available sources.
