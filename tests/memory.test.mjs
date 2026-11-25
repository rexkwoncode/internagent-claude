import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recall } from '../scripts/memory.mjs';

test('memory retrieves relevant successes and failures while skipping the current run', () => {
  const root = mkdtempSync(join(tmpdir(), 'internagent-memory-'));
  try {
    for (const [name, objective] of [['prior', 'electric load regression'], ['other', 'image segmentation'], ['current', 'electric load regression']]) {
      const run = join(root, name);
      mkdirSync(run);
      writeFileSync(join(run, 'state.json'), JSON.stringify({
        version: 1, spec: { objective, metric: 'mae', direction: 'minimize' },
        trials: [
          { id: '001', status: 'ok', score: 2, note: 'Used regularization' },
          { id: '002', status: 'failed', score: null, note: 'Failed on sparse features' },
        ],
      }));
    }
    const hits = recall(root, 'load regression', join(root, 'current'));
    assert.deepEqual(hits.map(hit => [hit.run, hit.status]), [
      [join(root, 'prior'), 'ok'], [join(root, 'prior'), 'failed'],
    ]);
    assert.deepEqual(recall(join(root, 'missing'), 'load'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
