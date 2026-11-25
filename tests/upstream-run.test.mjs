import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/upstream-run.mjs', import.meta.url));

test('upstream mailbox exposes and answers requests exactly once', () => {
  const mailbox = mkdtempSync(join(tmpdir(), 'internagent-mailbox-'));
  const id = 'abcd'.repeat(8);
  const path = join(mailbox, id + '.request.json');
  const response = join(mailbox, 'answer.json');
  const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  try {
    writeFileSync(path, JSON.stringify({ kind: 'text', model: 'haiku', prompt: 'explain RMSE' }));
    writeFileSync(response, JSON.stringify({ value: { invalid: 1 } }));
    assert.deepEqual(JSON.parse(cli('pending', mailbox).stdout).pending, [{ id, kind: 'text', model: 'haiku', path }]);
    assert.equal(cli('respond', mailbox, id, response).status, 1);
    assert.equal(cli('respond', mailbox, '../outside', response).status, 1);
    const answer = { value: 'Root mean squared error' };
    writeFileSync(response, JSON.stringify(answer));
    assert.equal(cli('respond', mailbox, id, response).status, 0);
    assert.equal(cli('respond', mailbox, id, response).status, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(mailbox, id + '.response.json'), 'utf8')), answer);
    writeFileSync(join(mailbox, 'result.json'), '{"engine":"InternAgent","exit":0}');
    assert.deepEqual(JSON.parse(cli('pending', mailbox).stdout), { pending: [], result: { engine: 'InternAgent', exit: 0 } });
  } finally {
    rmSync(mailbox, { recursive: true, force: true });
  }
});
