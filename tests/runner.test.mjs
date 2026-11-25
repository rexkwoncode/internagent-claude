import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const runner = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));

test('checkpointed candidates, objective ranking, logs, and winner-only holdout', () => {
  const working = mkdtempSync(join(tmpdir(), 'internagent test '));
  try {
    const run = join(working, 'run');
    const spec = join(working, 'task.json');
    function cli(...args) {
      return spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8' });
    }
    function json(...args) {
      const result = cli(...args);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    }
    mkdirSync(join(working, 'seed'));
    writeFileSync(join(working, 'seed', 'score.txt'), '1');
    writeFileSync(join(working, 'evaluate.mjs'), `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const val = Number(readFileSync(join(process.env.INTERNAGENT_CANDIDATE, 'score.txt'), 'utf8'));
      if (val < 0) throw new Error('failed training');
      writeFileSync(process.env.INTERNAGENT_METRICS, JSON.stringify({
        accuracy: val + (process.env.INTERNAGENT_PHASE === 'holdout' ? 100 : 0)
      }));
    `);
    const argv = [process.execPath, 'evaluate.mjs'];
    writeFileSync(spec, JSON.stringify({
      objective: 'maximize accuracy', seed: 'seed', direction: 'maximize',
      metric: 'accuracy', validation: argv, holdout: argv, trials: 4,
    }));

    json('init', spec, run);
    assert.equal(cli('init', spec, run).status, 1);
    const baseline = json('next', run);
    assert.deepEqual(json('next', run), baseline);
    assert.equal(cli('finish', run).status, 1);
    assert.equal(json('evaluate', run, baseline.id).score, 1);
    const draft = json('next', run);
    writeFileSync(join(draft.candidate, 'score.txt'), '5');
    assert.equal(json('evaluate', run, draft.id, 'better features').score, 5);
    const other = json('next', run);
    writeFileSync(join(other.candidate, 'score.txt'), '-1');
    const failed = json('evaluate', run, other.id);
    assert.equal(failed.status, 'failed');
    assert.match(readFileSync(join(failed.output, 'stderr.log'), 'utf8'), /failed training/);
    const debug = json('next', run);
    assert.deepEqual(debug.parents, [other.id]);
    writeFileSync(join(debug.candidate, 'score.txt'), '2');
    json('evaluate', run, debug.id);
    assert.equal(json('next', run).done, true);
    const final = json('finish', run);
    assert.equal(final.winner, draft.id);
    assert.equal(final.holdout.score, 105);
    assert.deepEqual(json('finish', run), final);
    assert.equal(json('status', run).trials.length, 4);
    assert.equal(readFileSync(join(baseline.candidate, 'score.txt'), 'utf8'), '1');
  } finally {
    rmSync(working, { recursive: true, force: true });
  }
});
