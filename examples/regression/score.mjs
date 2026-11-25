import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function sample(seed, size) {
  function random() {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  }
  return Array.from({ length: size }, () => {
    const x = Array.from({ length: 3 }, () => 4 * random() - 2);
    const y = 2 * x[0] - 1.5 * x[1] + x[0] * x[2] + 0.8 * x[2] ** 2 + (random() - 0.5) * 0.2;
    return { x, y };
  });
}

const path = resolve(process.env.INTERNAGENT_CANDIDATE, 'model.mjs');
const { train } = await import(pathToFileURL(path));
const predict = await train(sample(42, 300));
const rows = sample(process.env.INTERNAGENT_PHASE === 'holdout' ? 743 : 253, 120);
const errors = rows.map(({ x, y }) => {
  const output = predict(x);
  if (!Number.isFinite(output)) throw new Error('predict(x) must return a finite number');
  return output - y;
});
writeFileSync(process.env.INTERNAGENT_METRICS, JSON.stringify({
  mse: errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length,
  mae: errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length,
}));
