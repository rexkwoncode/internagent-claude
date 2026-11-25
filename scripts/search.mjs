export function leaderboard(trials, direction) {
  const sign = direction === 'minimize' ? 1 : -1;
  return trials.filter(t => t.status === 'ok')
    .sort((a, b) => sign * (a.score - b.score) || a.id.localeCompare(b.id));
}

function draftRoot(trial, byId) {
  while (trial.mode !== 'draft' && trial.parents.length) trial = byId.get(trial.parents[0]);
  return trial.id;
}

export function choose(trials, direction, budget) {
  if (trials.length >= budget) return null;
  if (!trials.length) return { mode: 'baseline', parents: [] };
  if (trials[0].status !== 'ok') return null;
  const last = trials.at(-1);
  if (last.status === 'failed' && !['baseline', 'debug'].includes(last.mode)) {
    return { mode: 'debug', parents: [last.id] };
  }

  const byId = new Map(trials.map(t => [t.id, t]));
  // Start with independent drafts, then prefer measured branches.
  const draftCount = trials.filter(t => t.mode === 'draft').length;
  if (draftCount < 2) return { mode: 'draft', parents: [trials[0].id] };
  const ranked = leaderboard(trials, direction);
  const best = ranked[0];
  const bestRoot = draftRoot(best, byId);
  const previous = leaderboard(trials.slice(0, -2), direction)[0];
  const other = ranked.find(t => draftRoot(t, byId) !== bestRoot && t.mode !== 'baseline');
  if (previous?.id === best.id && other && last.mode !== 'fusion') {
    return { mode: 'fusion', parents: [best.id, other.id] };
  }

  // Rank-normalized UCB combines quality and coverage across the search graph.
  const exploration = 0.65 * (1 - trials.length / budget);
  const utility = (trial, index) => {
    const children = trials.filter(t => t.parents.includes(trial.id)).length;
    return 1 - index / ranked.length + exploration * Math.sqrt(Math.log(trials.length) / (1 + children));
  };
  const selected = ranked.reduce((top, trial, index) =>
    utility(trial, index) > utility(top, ranked.indexOf(top)) ? trial : top, best);
  return { mode: 'improve', parents: [selected.id] };
}
