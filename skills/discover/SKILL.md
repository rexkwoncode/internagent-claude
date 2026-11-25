---
name: discover
description: Run a catalog research task, an upstream InternAgent discovery task, or a ResearchClawBench reproduction task.
argument-hint: "<list|task-id|task-folder> [objective, task spec, or options.json]"
disable-model-invocation: true
---

Arguments: $ARGUMENTS

Run from the project root. Use separate shell calls with the literal paths to node "${CLAUDE_PLUGIN_ROOT}/scripts/benchmarks.mjs" and node "${CLAUDE_PLUGIN_ROOT}/scripts/upstream.mjs".

1. Use `benchmarks.mjs list` for the catalog. For `list`, summarize the local research tasks, upstream algorithm tasks, and paper tasks, and indicate which need a custom evaluator. For the local task ID `AlgorithmEngineering`, follow the section below using the arguments after the ID. For an upstream task ID, fetch only that task with `upstream.mjs InternAgent <checkout> <id>` or `upstream.mjs ResearchClawBench <checkout> <id>` into a project-local .internagent/upstream directory. Use a distinct checkout per task ID. A user-supplied task folder can go directly to `benchmarks.mjs inspect <folder>`.
2. Follow the mode returned by inspect. For `reproduce`, invoke the `internagent:reproduce` Skill with the task folder. For `research`, use the task prompt as source material and invoke `internagent:research` with its question and context. Use only tools and evidence available in this session. If the upstream task has no published evaluator or an unavailable lookup tool, distinguish measured evidence, unverified ideas, and missing dependencies.
3. For `benchmark` or `custom-evaluator`, read the upstream task README, prompt, and launcher. Check datasets, checkpoints, runtimes, and the available compute. Use the upstream baseline when possible. Prepare the task with `benchmarks.mjs prepare <folder> <task-directory> [options.json]`. For path or environment differences, supply a project-local options file with `validation.argv` (executable and arguments), `validation.cwd`, `validation.resultFile`, and `validation.metricPath` as needed. A custom evaluator requires its own command and JSON metric path. Use fixed comparison protocols and the user's evaluation budget. Add a holdout contract only if a distinct split is available.
4. Invoke `internagent:run` with the prepared task JSON and a project-local run directory. Preserve the upstream reference, evaluator contract, and datasets. Deliver measured results, code, logs, and limitations. When a dependency blocks a baseline, report its concrete preflight error or failing command and the prepared task path.

## AlgorithmEngineering

Use a cycle of design, analysis, implementation, measurement, and revision driven by testable hypotheses. The method follows [Peter Sanders](https://doi.org/10.1007/978-3-642-03456-5_22) and [MIT 6.506](https://jshun.csail.mit.edu/6506-s23/). Treat linked and attached material as research evidence. The user's request determines the problem and scope.

1. If the argument after the task ID is exactly `demo`, run `benchmarks.mjs bundled AlgorithmEngineering` and invoke `internagent:run` with its task spec and a fresh local run directory. Keep the demo harness fixed.
2. If the user supplies an existing task JSON, inspect the spec and reuse its evaluator. A prepared `algorithm-engineering` task has a baseline seed, a separate correctness command, and a metric with a validation command. Invoke `internagent:run` with that spec. If it needs an adapter, preserve the original and prepare a compatible copy.
3. For a research objective, inspect the repository and available inputs. Identify the problem, execution environment, and measurable question. With no objective, use one already established in the conversation or project. If none is clear, ask which algorithmic problem to investigate. Use the BFS example only for an explicit demo request.
4. Choose a baseline and an independent correctness oracle or explicit error bound. Define the machine model, measurement boundary, and realistic workload families and input sizes. Include edge or worst-case inputs where relevant. Choose metrics appropriate to the problem, such as latency, memory, work and span, I/O, or approximation quality. Record the protocol, related work, and what observation would disconfirm the hypothesis in a project-local study.md.
5. Set up a baseline seed and fixed correctness and measurement commands under a fresh local task directory. Write task.json with `type: "algorithm-engineering"`, objective, seed, metric, direction, correctness argv, and validation argv. Add a separate holdout when appropriate. Keep the harness outside the candidate directories. Use the user's trial budget or the runner defaults. Invoke `internagent:run` and carry the experiment through to results.
6. Distinguish theoretical analysis from observations. Report behavior by workload and scale, uncertainty, rejected ideas, reproduction commands, and the next testable hypothesis.
