import { writeFileSync } from 'node:fs';
import { cpus, platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function randomGraph(size, seed, degree) {
  const graph = Array.from({ length: size }, () => []);
  for (const row of graph) {
    for (let edge = 0; edge < degree; edge++) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      row.push(seed % size);
    }
  }
  return graph;
}

function reference(graph, start) {
  const distance = Array(graph.length).fill(-1);
  let layer = [start];
  distance[start] = 0;
  while (layer.length) {
    const nextLayer = [];
    for (const vertex of layer) {
      for (const next of graph[vertex]) {
        if (distance[next] !== -1) continue;
        distance[next] = distance[vertex] + 1;
        nextLayer.push(next);
      }
    }
    layer = nextLayer;
  }
  return distance;
}

function testCase(name, graph, start) {
  for (const edges of graph) Object.freeze(edges);
  Object.freeze(graph);
  return { name, graph, start, expected: reference(graph, start) };
}

function check(actual, { name, expected }) {
  if (actual?.length !== expected.length) throw new Error(name + ': wrong result length');
  for (let vertex = 0; vertex < expected.length; vertex++) {
    if (actual[vertex] !== expected[vertex]) throw new Error(name + ': wrong distance for vertex ' + vertex);
  }
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

const { traverse } = await import(pathToFileURL(join(process.env.INTERNAGENT_CANDIDATE, 'traversal.mjs')));
const holdout = process.env.INTERNAGENT_PHASE === 'holdout';
const size = holdout ? 22003 : 18013;
const chainSize = Math.floor(size / 2);
const networks = [
  testCase('wide', [Array.from({ length: size - 1 }, (_, i) => i + 1),
    ...Array.from({ length: size - 1 }, () => [])], 0),
  testCase('sparse', randomGraph(size, holdout ? 42 : 17, holdout ? 5 : 4), holdout ? 3 : 0),
  testCase('chain', Array.from({ length: chainSize }, (_, i) =>
    i + 1 < chainSize ? [i + 1] : []), 0),
];
const edgeCases = [
  testCase('isolated', [[]], 0),
  testCase('duplicate edges and self-loop', [[0, 1, 1], [2], [], [1]], 0),
  testCase('directed disconnected components', [[1], [], [1, 3], [2]], 2),
];

if (process.argv[2] === 'check') {
  for (const input of [...edgeCases, ...networks]) check(traverse(input.graph, input.start), input);
} else if (process.argv[2] === 'measure') {
  for (let round = 0; round < 2; round++) {
    for (const input of networks) check(traverse(input.graph, input.start), input);
  }
  const rounds = 7;
  const totals = [];
  const samples = Object.fromEntries(networks.map(({ name }) => [name, []]));
  for (let round = 0; round < rounds; round++) {
    let total = 0;
    for (let offset = 0; offset < networks.length; offset++) {
      const input = networks[(round + offset) % networks.length];
      const start = performance.now();
      const actual = traverse(input.graph, input.start);
      const elapsed = performance.now() - start;
      check(actual, input);
      total += elapsed;
      samples[input.name].push(elapsed);
    }
    totals.push(total);
  }
  const metrics = {
    median_ms: median(totals),
    samples_ms: totals,
    workloads: networks.map(({ name, graph }) => ({
      name, vertices: graph.length, median_ms: median(samples[name]), samples_ms: samples[name],
    })),
    environment: { node: process.version, platform: platform(), cpu: cpus()[0]?.model },
  };
  writeFileSync(process.env.INTERNAGENT_METRICS, JSON.stringify(metrics, null, 2));
} else {
  throw new Error('Use check or measure.');
}
