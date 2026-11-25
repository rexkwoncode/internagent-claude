---
name: discover
description: Run a bundled research task, an upstream InternAgent discovery task, or a ResearchClawBench reproduction task.
argument-hint: "<list|task-id|task-folder> [options.json]"
disable-model-invocation: true
---

Arguments: $ARGUMENTS

Run from the project root. Use separate shell calls with the literal paths to node "${CLAUDE_PLUGIN_ROOT}/scripts/benchmarks.mjs" and node "${CLAUDE_PLUGIN_ROOT}/scripts/upstream.mjs".

1. Use `benchmarks.mjs list` for the catalog. For `list`, summarize the bundled, upstream algorithm, and paper tasks, and indicate which need a custom evaluator. For an ID under `localTasks`, run `benchmarks.mjs bundled <id>`, then invoke `internagent:run` with its task spec and a fresh project-local run directory. Keep the bundled benchmark files fixed. For an upstream task ID, fetch only that task with `upstream.mjs InternAgent <checkout> <id>` or `upstream.mjs ResearchClawBench <checkout> <id>` into a project-local .internagent/upstream directory. Use a distinct checkout per task ID. A user-supplied task folder can go directly to `benchmarks.mjs inspect <folder>`.
2. Follow the mode returned by inspect. For `reproduce`, invoke the `internagent:reproduce` Skill with the task folder. For `research`, use the task prompt as source material and invoke `internagent:research` with its question and context. Use only tools and evidence available in this session. If the upstream task has no published evaluator or an unavailable lookup tool, distinguish measured evidence, unverified ideas, and missing dependencies.
3. For `benchmark` or `custom-evaluator`, read the upstream task README, prompt, and launcher. Check datasets, checkpoints, runtimes, and the available compute. Use the upstream baseline when possible. Prepare the task with `benchmarks.mjs prepare <folder> <task-directory> [options.json]`. For path or environment differences, supply a project-local options file with `validation.argv` (executable and arguments), `validation.cwd`, `validation.resultFile`, and `validation.metricPath` as needed. A custom evaluator requires its own command and JSON metric path. Use fixed comparison protocols and the user's evaluation budget. Add a holdout contract only if a distinct split is available.
4. Invoke `internagent:run` with the prepared task JSON and a project-local run directory. Preserve the upstream reference, evaluator contract, and datasets. Deliver measured results, code, logs, and limitations. When a dependency blocks a baseline, report its concrete preflight error or failing command and the prepared task path.
