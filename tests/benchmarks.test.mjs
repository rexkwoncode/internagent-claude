import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { metricValue } from '../scripts/benchmarks.mjs';

const adapter = fileURLToPath(new URL('../scripts/benchmarks.mjs', import.meta.url));
const runner = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));
const repo = fileURLToPath(new URL('../', import.meta.url));
const invoke = (script, cwd, ...args) => spawnSync(process.execPath, [script, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(cwd, 'test-claude') },
});

function json(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('upstream Git submodules match the runtime fetch pins', { skip: !existsSync(join(repo, '.git')) }, () => {
  const pins = JSON.parse(readFileSync(join(repo, 'upstream/revisions.json'), 'utf8'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  for (const name of ['MLEvolve', 'ResearchClawBench']) {
    const path = 'upstream/' + name;
    assert.equal(git('ls-files', '--stage', '--', path), '160000 ' + pins[name].commit + ' 0\t' + path);
    assert.equal(git('config', '-f', '.gitmodules', '--get', 'submodule.' + name + '.path'), path);
    assert.equal(git('config', '-f', '.gitmodules', '--get', 'submodule.' + name + '.url'), pins[name].url);
  }
});

test('task catalog and paper routing', () => {
  const catalog = json(invoke(adapter, tmpdir(), 'list'));
  assert.equal(Object.keys(catalog.algorithmTasks).length, 13);
  assert.equal(catalog.localTasks.AlgorithmEngineering.mode, 'research-task');
  assert.equal(catalog.localTasks.AlgorithmEngineering.taskType, 'algorithm-engineering');
  assert.equal(catalog.localTasks.AlgorithmEngineering.skill, undefined);
  assert.equal(catalog.localTasks.AlgorithmEngineering.taskSpec, undefined);
  const bundled = json(invoke(adapter, tmpdir(), 'bundled', 'AlgorithmEngineering'));
  assert.equal(JSON.parse(readFileSync(bundled.taskSpec, 'utf8')).type, 'algorithm-engineering');
  assert.equal(catalog.algorithmTasks.AutoDrug.mode, 'research');
  assert.equal(catalog.algorithmTasks.AutoTTRL.mode, 'custom-evaluator');
  assert.equal(catalog.paperTasks.length, 40);
  assert.equal(metricValue({ result: { 'val/score': 3 } }, ['result', 'val/score']), 3);
  assert.throws(() => metricValue({ score: '3' }, ['score']), /finite benchmark score/);
  assert.equal(metricValue({ score: '3.25e-2' }, ['score'], true), 0.0325);
  assert.throws(() => metricValue({}, ['constructor']), /finite benchmark score/);
});

test('benchmark preparation, result bridge, and separate holdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'internagent benchmark '));
  try {
    const upstream = join(root, 'AutoCls3D');
    const code = join(upstream, 'code');
    const target = join(root, 'task');
    const run = join(root, 'run');
    mkdirSync(code, { recursive: true });
    writeFileSync(join(upstream, 'prompt.json'), JSON.stringify({ task_description: 'Classify point clouds' }));
    writeFileSync(join(code, 'experiment.mjs'), `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const output = join(process.argv[2], 'final_info.json');
      const best_oa = process.argv[3] === 'holdout' ? 0.8 : 0.9;
      writeFileSync(output, JSON.stringify({ modelnet40: { means: { best_oa } } }));
    `);
    const options = join(root, 'options.json');
    const argv = [process.execPath, 'experiment.mjs', '{output}'];
    writeFileSync(options, JSON.stringify({
      validation: { argv }, holdout: { argv: [...argv, 'holdout'] }, trials: 1, timeoutSeconds: 20,
    }));

    const prepared = json(invoke(adapter, root, 'prepare', upstream, target, options));
    assert.equal(prepared.metric, 'best_oa');
    assert.equal(prepared.mode, 'benchmark');
    assert.equal(prepared.holdout, true);
    assert.equal(invoke(adapter, root, 'prepare', upstream, target, options).status, 1);
    json(invoke(runner, root, 'init', prepared.taskSpec, run));
    const trial = json(invoke(runner, root, 'next', run));
    const scored = json(invoke(runner, root, 'evaluate', run, trial.id));
    assert.equal(scored.score, 0.9);
    assert.equal(existsSync(join(trial.candidate, 'run_output')), false);
    assert.equal(json(invoke(runner, root, 'finish', run)).holdout.score, 0.8);

    const paper = join(root, 'Astronomy_000');
    mkdirSync(paper);
    writeFileSync(join(paper, 'task_info.json'), '{}');
    assert.equal(json(invoke(adapter, root, 'inspect', paper)).mode, 'reproduce');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
