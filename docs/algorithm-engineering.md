# AlgorithmEngineering

Pass a research objective or a prepared task spec to the AlgorithmEngineering catalog task.

```text
/internagent:discover AlgorithmEngineering Compare stable sorting strategies on partially ordered data
/internagent:discover AlgorithmEngineering sort-task.json
```

With no arguments after the task ID, the workflow uses the research problem from your project or asks you to choose one. It establishes a testable hypothesis, realistic input families and a machine model, correctness criteria, and a reproducible measurement protocol. Each round uses the measured results to inform the next design. The workflow applies to problems such as sorting, graph algorithms, indexing, compression, parallel algorithms, and external-memory algorithms. [Peter Sanders’s methodology](https://doi.org/10.1007/978-3-642-03456-5_22) · [MIT 6.506](https://jshun.csail.mit.edu/6506-s23/)

## Prepare a task

Follow the [experiment contract](../README.md#prepare-an-experiment), set `"type": "algorithm-engineering"`, and provide `correctness` as an executable and argument array. The runner checks correctness before scoring both validation and holdout. A nonzero exit excludes the candidate from ranking. Measurement commands can report runtime, throughput, memory, or another numeric metric using the same contract as other tasks.

```json
{
  "type": "algorithm-engineering",
  "objective": "Compare exact sorting implementations on partially ordered inputs.",
  "seed": "seed",
  "metric": "median_ms",
  "direction": "minimize",
  "correctness": ["node", "check.mjs"],
  "validation": ["node", "measure.mjs"],
  "holdout": ["node", "measure.mjs"],
  "trials": 6,
  "timeoutSeconds": 600
}
```

## Run the example

```text
/internagent:discover AlgorithmEngineering demo
```

The [BFS example](../examples/algorithm-engineering/) compares graph traversal implementations on wide, sparse, and chain graphs with warmups, repeated measurements, and different holdout inputs.
