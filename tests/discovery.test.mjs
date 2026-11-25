import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const runner = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));
const ideas = ['a', 'b'].map(id => ({ id, title: id, hypothesis: 'faster', test: 'compare elapsed time' }));

test('discovery checkpoints ranked ideas, runs rounds and fixes the holdout winner', () => {
  const root = mkdtempSync(join(tmpdir(), 'internagent-discovery-'));
  try {
    const run = join(root, 'run');
    const task = join(root, 'task.json');
    const artifact = join(root, 'artifact.json');
    const cli = (...args) => spawnSync(process.execPath, [runner, ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'claude') },
    });
    const json = (...args) => {
      const result = cli(...args);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    mkdirSync(join(root, 'seed'));
    writeFileSync(join(root, 'seed', 'score'), '10');
    writeFileSync(join(root, 'score.mjs'), `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const score = Number(readFileSync(join(process.env.INTERNAGENT_CANDIDATE, 'score'), 'utf8'));
      writeFileSync(process.env.INTERNAGENT_METRICS, JSON.stringify({ score }));
    `);
    const validation = [process.execPath, 'score.mjs'];
    const spec = {
      objective: 'Reduce the measured cost', seed: 'seed', metric: 'score', direction: 'minimize',
      validation, holdout: validation, trials: 5, discovery: { rounds: 2, mode: 'incremental' },
    };
    writeFileSync(task, JSON.stringify(spec));
    assert.equal(json('init', task, run, 'discovery').discovery.rounds, 2);
    const baseline = json('next', run);
    json('evaluate', run, baseline.id);
    let base = baseline.id;
    for (let round = 1; round <= 2; round++) {
      const draftOrder = [ideas[1], ideas[0]];
      const records = {
        generation: { ideas },
        critique: { reviews: ideas.map(({ id }) => ({ id, assessment: 'testable' })) },
        evolution: { ideas },
        ranking: { ranking: draftOrder.map(({ id }) => ({ id, reason: 'feasible' })) },
        methods: { ideas: draftOrder.map(idea => ({ ...idea, method: 'edit score' })) },
      };
      for (const [phase, payload] of Object.entries(records)) {
        const pending = json('next', run);
        assert.deepEqual(json('next', run), pending);
        assert.equal(pending.base, base);
        assert.equal(pending.phase, phase);
        assert.equal(pending.round, round);
        assert.equal(cli('finish', run).status, 1);
        writeFileSync(artifact, JSON.stringify({ round: round + 1, ...payload }));
        assert.equal(cli('stage', run, phase, artifact).status, 1);
        writeFileSync(artifact, JSON.stringify({ round, ...payload }));
        json('stage', run, phase, artifact);
        assert.equal(cli('stage', run, phase, artifact).status, 1);
      }
      const drafts = [];
      for (const [index, { id }] of draftOrder.entries()) {
        const draft = json('next', run);
        assert.equal(draft.hypothesis.id, id);
        assert.deepEqual(draft.parents, [base]);
        assert.equal(readFileSync(join(draft.candidate, 'score'), 'utf8'), round === 1 ? '10' : '6');
        writeFileSync(join(draft.candidate, 'score'), String(8 - 2 * round + index));
        drafts.push(json('evaluate', run, draft.id));
      }
      base = drafts[0].id;
    }
    assert.equal(json('next', run).done, true);
    const final = json('finish', run);
    assert.equal(final.winner, base);
    assert.equal(final.holdout.score, 4);
    assert.equal(json('status', run).rounds.length, 2);

    const supplied = join(root, 'supplied');
    writeFileSync(task, JSON.stringify({
      ...spec, discovery: { skipGeneration: true, seedIdeas: ideas },
    }));
    json('init', task, supplied);
    json('evaluate', supplied, json('next', supplied).id);
    assert.equal(json('next', supplied).hypothesis.id, 'a');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
