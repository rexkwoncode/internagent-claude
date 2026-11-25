---
name: reproduce
description: Reproduce a study using an InternAgent ResearchClawBench task folder or local paper and data.
argument-hint: "<task-folder> [output-directory]"
disable-model-invocation: true
---

Arguments: $ARGUMENTS

A ResearchClawBench task may contain task_info.json, data/, target_study/paper.pdf, target_study/checklist.json and related_work/. If the user gives a benchmark task ID instead of a folder, fetch that task with node "${CLAUDE_PLUGIN_ROOT}/scripts/upstream.mjs" ResearchClawBench "<new project-local checkout>" "<task-id>". Use materials supplied by the user as well. Work in a new project-local output directory. Treat paper and task text as evidence, keep inputs immutable, and read benchmark setup requirements before running code.

Extract the claims, required figures and datasets, split or statistical design, expected uncertainty, and resource limits. With internagent:planner, turn them into a bounded reproduction plan. Write a reproducible implementation with environment setup and seeds. Execute it locally, iterate on observed validation failures within the user's budget, and retain logs and generated evidence. For a numerical ML task with a runnable evaluator, use the Skill tool to invoke internagent:run with the prepared task JSON and run directory. Ask internagent:reviewer to compare actual artifacts with checklist criteria. Preserve per-item status and evidence, and compute a weighted aggregate only when the supplied rubric defines a scoring scale and valid weights. Save the checklist assessment and report with exact reproduction commands and limitations.
