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

function pickWeighted(candidates, weight, fraction) {
  let cursor = fraction * candidates.reduce((total, candidate) => total + weight(candidate), 0);
  for (const candidate of candidates) {
    cursor -= weight(candidate);
    if (cursor < 0) return candidate;
  }
  return candidates.at(-1);
}

export function explore(trials, direction, limit, base) {
  const failed = trials.find(trial => trial.status === 'failed' && trial.mode !== 'debug' &&
    !trials.some(child => child.mode === 'debug' && child.parents[0] === trial.id));
  if (failed) return { mode: 'debug', parents: [failed.id], idea: failed.idea };

  const ranked = leaderboard(trials, direction);
  if (!ranked.length) return { mode: 'evolve', parents: [base], evidence: trials.map(trial => trial.id) };

  const byId = new Map(trials.map(trial => [trial.id, trial]));
  const graphRoots = new Set(['draft', 'fusion']);
  const lineage = trial => {
    const path = [trial.id];
    while (!graphRoots.has(trial.mode) && byId.has(trial.parents[0])) {
      trial = byId.get(trial.parents[0]);
      path.push(trial.id);
    }
    return path;
  };
  const branches = new Map();
  const stats = new Map(trials.map(trial => [trial.id, { visits: 0, reward: 0 }]));
  const rewards = new Map(ranked.map((trial, index) => [trial.id, 1 - index / ranked.length]));
  for (const trial of trials) {
    const path = lineage(trial);
    const root = path.at(-1);
    if (!branches.has(root)) branches.set(root, []);
    branches.get(root).push(trial);
    for (const id of path) {
      const metric = stats.get(id);
      metric.visits += 1;
      metric.reward += rewards.get(trial.id) ?? 0;
    }
  }

  const best = ranked[0];
  const bestRoot = lineage(best).at(-1);
  const stagnant = trials.length - 1 - trials.indexOf(best) >= 3;
  const usedFusion = (a, b) => trials.some(trial => trial.mode === 'fusion' &&
    trial.parents.includes(a) && trial.parents.includes(b));
  const complement = ranked.find(trial => lineage(trial).at(-1) !== bestRoot && !usedFusion(best.id, trial.id));
  if (stagnant && complement && trials.at(-1).mode !== 'fusion') {
    return { mode: 'fusion', parents: [best.id, complement.id],
      evidence: [...branches.get(bestRoot), ...branches.get(lineage(complement).at(-1))].map(trial => trial.id) };
  }

  const progress = trials.length / limit;
  const explorationWeight = Math.max(0.2, 1 - 4 * Math.max(0, progress - 0.5));
  const fraction = ((trials.length + Number(trials[0].id)) * 0.61803398875) % 1;
  let parent;
  if (fraction >= explorationWeight) {
    const branchCounts = new Map();
    const top = [];
    for (const trial of ranked) {
      const root = lineage(trial).at(-1);
      const count = branchCounts.get(root) ?? 0;
      if (count >= (progress < 0.7 ? 2 : 1)) continue;
      top.push(trial);
      branchCounts.set(root, count + 1);
      if (top.length === (progress < 0.7 ? 8 : 4)) break;
    }
    parent = pickWeighted(top, trial => 1 / (top.indexOf(trial) + 1),
      (fraction - explorationWeight) / (1 - explorationWeight));
  } else {
    const exploration = Math.max(0.7, Math.SQRT2 - 2 * Math.max(0, progress - 0.3));
    const uct = (trial, visits) => {
      const metric = stats.get(trial.id);
      return metric.reward / metric.visits + exploration * Math.sqrt(Math.log(visits + 1) / metric.visits);
    };
    const select = (candidates, visits) => candidates.reduce((a, b) => uct(b, visits) > uct(a, visits) ? b : a);
    const roots = [...branches.values()].filter(branch => branch.some(trial => rewards.has(trial.id)));
    parent = select(roots.map(branch => branch[0]), trials.length);
    while (true) {
      const children = trials.filter(trial => trial.parents[0] === parent.id && trial.mode !== 'fusion' &&
        stats.get(trial.id).reward > 0);
      if (children.length < 2 && parent.status === 'ok') break;
      parent = select(children, stats.get(parent.id).visits);
    }
  }
  const branch = branches.get(lineage(parent).at(-1));
  const branchBest = leaderboard(branch, direction)[0];
  if (branch.length - 1 - branch.indexOf(branchBest) >= 3 &&
      !branch.slice(branch.indexOf(branchBest) + 1).some(trial => trial.mode === 'evolve')) {
    return { mode: 'evolve', parents: [branchBest.id], idea: branchBest.idea, evidence: branch.map(trial => trial.id) };
  }
  return { mode: 'improve', parents: [parent.id], idea: parent.idea, evidence: branch.map(trial => trial.id) };
}
