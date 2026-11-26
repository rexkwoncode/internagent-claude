---
name: build
description: Set up and run a reproducible experiment for a research objective in the current project.
argument-hint: "<research objective and relevant constraints>"
disable-model-invocation: true
---

User objective: $ARGUMENTS

Use persistent model settings automatically. If the user explicitly specifies overrides for this task, put them in the optional `models` object in task.json, with `default` or role keys `planner`, `builder`, and `reviewer`. Preserve overrides in an existing task. Before any setup call to the planner, use node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" models from the project root, with the task JSON path if it exists. Pass the returned planner alias as the Agent tool's `model` argument, or omit the argument for `inherit`. If the tool cannot use an explicit alias or reports a replacement, stop and report the issue.

Inspect the project for the code or process under study, available inputs and workloads, expected behavior, existing benchmarks, and resource constraints. Establish a measurable research question, a reproducible baseline, and the primary metric and direction. Reuse the project's existing baseline and evaluator where available. Otherwise use internagent:planner to propose a baseline, independent checks, and a stable evaluation protocol, then prepare the experiment locally. Ask only for missing information that materially changes what should be measured or built. Match the protocol to the problem. Algorithm work may require a correctness oracle and repeated timing. A simulation may require fixed inputs, reference invariants, and sensitivity analysis. Model building may require disjoint data splits and training-only fitting.

By default, prepare an upstream InternAgent task in a project-local folder and invoke the `internagent:run` Skill with that folder. Inspect the pinned AutoDebug task to match the upstream task contract. Write its `prompt.json` with the objective, constraints, baseline, primary metric and direction. Put trusted project code and the launcher in the upstream task layout and establish baseline results using the original evaluation contract. Preserve the evaluator, datasets, and existing project entry points. For ML model-building and optimization, use `engine: "InternAgent"` with the nested MLEvolve backend settings in `docs/upstream-runtime.md`. Establish comparable development metrics for the baseline and the chosen candidate, and keep the final holdout separate. Use direct MLEvolve only if explicitly requested.

If the user explicitly selects the lightweight workflow or supplies an existing lightweight task JSON, prepare or reuse the seed and evaluator spec documented in the README and invoke `internagent:lightweight`. A missing upstream dependency is a preflight issue. Report it and preserve the prepared task.

Deliver the candidate implementation, measured comparison, artifacts, limitations, and exact reproduction commands.
