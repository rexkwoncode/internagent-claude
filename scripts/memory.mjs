import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const tokens = value => new Set((value.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []));

export function recall(root, objective, exclude) {
  const query = tokens(objective);
  if (!query.size) return [];
  const hits = [];
  let directories;
  try {
    directories = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  for (const entry of directories) {
    if (!entry.isDirectory()) continue;
    const run = resolve(root, entry.name);
    if (run === exclude) continue;
    let state;
    try {
      state = JSON.parse(readFileSync(join(run, 'state.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    if (state?.version !== 1 || !Array.isArray(state.trials) || typeof state.spec?.objective !== 'string') continue;
    const { objective: previous, metric, direction } = state.spec;
    for (const trial of state.trials) {
      if (!trial.note || trial.status === 'pending') continue;
      const words = tokens(previous + ' ' + trial.note);
      const overlap = [...query].filter(word => words.has(word)).length;
      if (!overlap) continue;
      hits.push({
        relevance: overlap / Math.sqrt(query.size * words.size),
        run, objective: previous, metric, direction,
        id: trial.id, status: trial.status, score: trial.score, note: trial.note,
      });
    }
  }
  return hits.sort((a, b) => b.relevance - a.relevance || a.run.localeCompare(b.run) ||
    a.id.localeCompare(b.id)).slice(0, 8);
}
