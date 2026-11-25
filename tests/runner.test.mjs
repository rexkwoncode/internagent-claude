import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const runner = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));

test('persistent model policy precedence, validation, and resume', () => {
  const working = mkdtempSync(join(tmpdir(), 'internagent-models-'));
  try {
    const file = join(working, 'task.json');
    const run = join(working, 'run');
    const userDir = join(working, 'claude');
    const userFile = join(userDir, 'internagent.json');
    const projectFile = join(working, 'internagent.config.json');
    const spec = {
      objective: 'minimize error', seed: 'seed', direction: 'minimize',
      metric: 'mse', validation: [process.execPath, 'evaluate.mjs'],
    };
    const cli = (...args) => spawnSync(process.execPath, [runner, ...args], {
      cwd: working, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: userDir },
    });
    const writeSpec = value => writeFileSync(file, JSON.stringify(value));
    mkdirSync(join(working, 'seed'));
    mkdirSync(userDir);
    const user = cli('configure', 'user', 'default', 'haiku');
    assert.equal(user.status, 0, user.stderr);
    assert.equal(cli('configure', 'user', 'builder', 'sonnet').status, 0);
    assert.equal(cli('configure', 'project', 'reviewer', 'inherit').status, 0);
    assert.equal(cli('configure', 'project', 'builder', 'invalid').status, 1);
    assert.deepEqual(JSON.parse(readFileSync(userFile, 'utf8')).models, {
      default: 'haiku', builder: 'sonnet',
    });
    assert.deepEqual(JSON.parse(cli('models').stdout), {
      planner: 'haiku', builder: 'sonnet', reviewer: 'inherit',
    });
    assert.equal(cli('configure', 'project', 'reviewer', 'clear').status, 0);
    assert.equal(JSON.parse(cli('models').stdout).reviewer, 'haiku');
    assert.equal(cli('configure', 'project', 'reviewer', 'inherit').status, 0);
    for (const [models, message] of [
      [null, /models must be an object/],
      [{ coder: 'haiku' }, /Unknown models key: coder/],
      [{ builder: 'claude-sonnet-5' }, /models.builder must be one of/],
    ]) {
      writeSpec({ ...spec, models });
      const invalid = cli('init', file, run);
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, message);
    }
    writeSpec({ ...spec, models: { default: 'sonnet', builder: 'opus' } });
    const init = cli('init', file, run);
    assert.equal(init.status, 0, init.stderr);
    const expected = { planner: 'sonnet', builder: 'opus', reviewer: 'sonnet' };
    assert.deepEqual(JSON.parse(init.stdout).models, expected);
    writeSpec(spec);
    rmSync(userFile);
    rmSync(projectFile);
    assert.deepEqual(JSON.parse(cli('status', run).stdout).models, expected);

    writeFileSync(projectFile, '{}');
    assert.match(cli('models').stderr, /models in .*internagent\.config\.json must be an object/);
    rmSync(projectFile);
    const legacy = cli('init', file, join(working, 'legacy'));
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.deepEqual(JSON.parse(legacy.stdout).models, {
      planner: 'inherit', builder: 'inherit', reviewer: 'inherit',
    });
  } finally {
    rmSync(working, { recursive: true, force: true });
  }
});

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
