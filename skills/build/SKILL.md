---
name: build
description: Turn a local ML project and objective into a scored InternAgent task and execute model search.
argument-hint: "<model objective, data, target, and metric>"
disable-model-invocation: true
---

User objective: $ARGUMENTS

Inspect the current project for the dataset schema, training and inference interfaces, existing split, evaluator, tests, runtime, and resource constraints. Use an existing reproducible baseline and evaluator when available. If missing, use internagent:planner to define a basic baseline and stable validation protocol, then implement a project-local starter and evaluator. Ask for a target, data location, or metric only when the missing value materially changes the experiment and cannot be inferred. Respect the user's data handling and repository conventions.

Create a task folder with task.json, a small candidate seed, and trusted evaluator commands. The task JSON uses objective, seed (a directory path relative to task.json), metric, direction (minimize or maximize), validation (executable and arguments as an array), and optional holdout, trials, and timeoutSeconds. The evaluator runs from the task folder. It loads code from INTERNAGENT_CANDIDATE, chooses the data split with INTERNAGENT_PHASE, writes artifacts under INTERNAGENT_OUTPUT, and writes a JSON object keyed by metric to INTERNAGENT_METRICS. Separate training from scoring. Use stable split groups, seeds, and metrics and preserve the project's test set for a final holdout if available. Preserve normal project entry points. Store task artifacts under .internagent unless the user supplied a project location. After setup, use the Skill tool to invoke internagent:run with the task.json path and run directory as arguments. Then carry out its directions in this session. Deliver the winning model code, any evaluator-exported artifact, the measured comparison, and reproducibility instructions.
