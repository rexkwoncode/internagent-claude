import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choose, leaderboard } from '../scripts/search.mjs';

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
