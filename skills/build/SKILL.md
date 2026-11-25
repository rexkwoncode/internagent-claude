---
name: build
description: Set up and run a reproducible experiment for a research objective in the current project.
argument-hint: "<research objective and relevant constraints>"
disable-model-invocation: true
---

User objective: $ARGUMENTS

Use persistent model settings automatically. If the user explicitly specifies overrides for this task, put them in the optional `models` object in task.json, with `default` or role keys `planner`, `builder`, and `reviewer`. Preserve overrides in an existing task. Before any setup call to the planner, use node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" models from the project root, with the task JSON path if it exists. Pass the returned planner alias as the Agent tool's `model` argument, or omit the argument for `inherit`. If the tool cannot use an explicit alias or reports a replacement, stop and report the issue.

Inspect the project for the code or process under study, available inputs and workloads, expected behavior, existing benchmarks, and resource constraints. Establish a measurable research question, a reproducible baseline, and the primary metric and direction. Reuse the project's existing baseline and evaluator where available. Otherwise use internagent:planner to propose a baseline, independent checks, and a stable evaluation protocol, then prepare the experiment locally. Ask only for missing information that materially changes what should be measured or built. Match the protocol to the problem. Algorithm work may require a correctness oracle and repeated timing. A simulation may require fixed inputs, reference invariants, and sensitivity analysis. Model building may require disjoint data splits and training-only fitting.

Create a task folder with task.json, a small candidate seed, and fixed evaluator commands. The task JSON uses objective, seed (a path relative to task.json), metric, direction (minimize or maximize), validation (executable and arguments as an array), and optional holdout, constraints, trials, and timeoutSeconds. For algorithm engineering, set `type: "algorithm-engineering"` and provide a separate correctness command as an argument array. The evaluator runs from the task folder, loads the candidate from INTERNAGENT_CANDIDATE, uses INTERNAGENT_PHASE to select workloads or inputs when relevant, writes artifacts under INTERNAGENT_OUTPUT, and writes a JSON object keyed by metric to INTERNAGENT_METRICS.

Keep evaluation and the candidate implementation separate. Fix input selection, repeat counts, and resource limits where they affect comparability. Add a holdout only when a distinct evaluation is available and useful. Preserve normal project entry points. Store task artifacts under .internagent unless the user supplied a project location. Then invoke the internagent:run Skill with the task spec and run directory and carry it through. Deliver the candidate implementation, measured comparison, output artifacts, limitations, and exact reproduction commands.
