import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choose, explore, leaderboard } from '../scripts/search.mjs';

const base = { id: '000', mode: 'baseline', parents: [], status: 'ok', score: 10 };
const a = { id: '001', mode: 'draft', parents: ['000'], status: 'ok', score: 5 };
const b = { id: '002', mode: 'draft', parents: ['000'], status: 'ok', score: 7 };
const failure = { id: '003', mode: 'debug', parents: ['001'], status: 'failed', score: null };
test('baseline, independent drafts and direction-aware ranking', () => {
  assert.equal(choose([], 'minimize', 8).mode, 'baseline');
  assert.equal(choose([base, a], 'minimize', 8).mode, 'draft');
  assert.deepEqual(leaderboard([base, a, b, failure], 'minimize').map(t => t.id), ['001','002','000']);
  assert.equal(leaderboard([base, a, b], 'maximize')[0].id, '000');
});
test('refinement, debug lineage, fusion and budget', () => {
  assert.equal(choose([base, a, b], 'minimize', 8).mode, 'improve');
  const failed = { ...failure, mode: 'improve' };
  assert.deepEqual(choose([base, a, b, failed], 'minimize', 8), { mode: 'debug', parents: ['003'] });
  const worse = { id: '004', mode: 'debug', parents: ['003'], status: 'ok', score: 8 };
  assert.deepEqual(choose([base, a, b, failed, worse], 'minimize', 8), { mode: 'fusion', parents: ['001', '002'] });
  assert.equal(choose([base, a, b], 'minimize', 3), null);
});

test('discovery can repair failed branches, fuse stagnating branches, and evolve from a trajectory', () => {
  const broken = { ...a, status: 'failed', score: null, idea: 'broken' };
  assert.deepEqual(explore([broken, b], 'minimize', 8, base.id), {
    mode: 'debug', parents: [a.id], idea: 'broken',
  });
  const refine = (id, parent, score) => ({
    id, mode: 'improve', parents: [parent], status: 'ok', score,
  });
  const steps = [refine('003', a.id, 8), refine('004', '003', 9), refine('005', '004', 10)];
  const fusion = explore([a, b, ...steps], 'minimize', 10, base.id);
  assert.equal(fusion.mode, 'fusion');
  assert.deepEqual(fusion.parents, [a.id, b.id]);
  assert.equal(fusion.evidence.length, 5);
  assert.deepEqual(explore([a, ...steps], 'minimize', 10, base.id), {
    mode: 'evolve', parents: [a.id], idea: undefined, evidence: [a.id, '003', '004', '005'],
  });
  assert.deepEqual(explore([broken, failure], 'minimize', 10, base.id), {
    mode: 'evolve', parents: [base.id], evidence: [a.id, failure.id],
  });
});
