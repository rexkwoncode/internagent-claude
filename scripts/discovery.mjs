import { choose, leaderboard, explore } from './search.mjs';

const phases = ['generation', 'critique', 'evolution', 'ranking', 'methods'];
const text = value => typeof value === 'string' && Boolean(value.trim());

function ideas(value, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 24 ||
      value.some(idea => !idea || typeof idea.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(idea.id) ||
        !['title', 'hypothesis', 'test'].every(field => text(idea[field]))) ||
      new Set(value.map(idea => idea.id)).size !== value.length) {
    throw new Error('Provide distinct ideas with a lowercase slug id, title, hypothesis, and falsification test.');
  }
  return value;
}

export function validateDiscovery(value, budget) {
  if (value === false || value === undefined) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('discovery must be an object or false.');
  }
  const settings = {
    rounds: 1, mode: 'fresh', topIdeas: 2, seedIdeas: [], skipGeneration: false, ...value,
  };
  const { rounds, mode, topIdeas, seedIdeas, skipGeneration, feedback } = settings;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > Math.max(1, budget - 1) ||
      !Number.isInteger(topIdeas) || topIdeas < 1 || topIdeas > 8 ||
      !['fresh', 'incremental'].includes(mode) || typeof skipGeneration !== 'boolean' ||
      (feedback !== undefined && !text(feedback))) {
    throw new Error('Specify discovery.rounds within the candidate budget, topIdeas between 1 and 8, and mode fresh or incremental.');
  }
  if (!Array.isArray(seedIdeas)) throw new Error('discovery.seedIdeas must be an array.');
  if (seedIdeas.length) ideas(seedIdeas);
  if (skipGeneration && (rounds !== 1 || !seedIdeas.length)) {
    throw new Error('Discovery with supplied ideas only requires seedIdeas and exactly one round.');
  }
  return settings;
}

function phaseFor(round) {
  return phases.find(phase => !Object.hasOwn(round, phase));
}

function newRound(state, number, limit) {
  const options = state.spec.discovery;
  const round = { number, limit, base: '000' };
  if (options.mode === 'incremental') {
    round.base = leaderboard(state.trials, state.spec.direction)[0].id;
  }
  if (options.skipGeneration) {
    round.methods = options.seedIdeas.slice(0, Math.min(limit, options.topIdeas));
    round.supplied = true;
  }
  return round;
}

export function advance(state) {
  const { spec, trials } = state;
  const options = spec.discovery;
  if (!options || !trials.length || trials[0].status !== 'ok') {
    return choose(trials, spec.direction, spec.trials);
  }
  if (trials.length >= spec.trials) return null;
  const rounds = state.rounds ??= [];
  let round = rounds.at(-1);
  if (!round || trials.filter(trial => trial.round === round.number).length >= round.limit) {
    const number = rounds.length + 1;
    const limit = Math.floor((spec.trials - trials.length) / (options.rounds - number + 1));
    round = newRound(state, number, limit);
    rounds.push(round);
  }
  const phase = round.supplied ? undefined : phaseFor(round);
  const count = Math.min(round.limit, options.topIdeas);
  if (phase) return { phase, round: round.number, count, base: round.base };
  const withinRound = trials.filter(trial => trial.round === round.number);
  const untested = round.methods.find(idea => !withinRound.some(trial => trial.idea === idea.id));
  if (untested) {
    return { mode: 'draft', parents: [round.base], round: round.number, idea: untested.id };
  }
  return { ...explore(withinRound, spec.direction, round.limit, round.base), round: round.number };
}

export function recordPhase(state, phase, artifact) {
  const round = state.rounds?.at(-1);
  if (!round || round.supplied || phase !== phaseFor(round)) {
    throw new Error('Run next and submit the requested discovery phase in order.');
  }
  if (!artifact || typeof artifact !== 'object' || artifact.round !== round.number) {
    throw new Error('The phase artifact must include the active round number.');
  }
  const count = Math.min(round.limit, state.spec.discovery.topIdeas);
  const evolvedIds = round.evolution?.ideas.map(idea => idea.id);
  switch (phase) {
    case 'generation':
    case 'evolution':
      ideas(artifact.ideas, count);
      break;
    case 'critique':
      if (!Array.isArray(artifact.reviews) || artifact.reviews.length !== round.generation.ideas.length ||
          round.generation.ideas.some(idea => artifact.reviews.filter(review => review?.id === idea.id &&
            text(review.assessment)).length !== 1)) {
        throw new Error('Critique must include one assessment for every generated idea.');
      }
      break;
    case 'ranking':
      if (!Array.isArray(artifact.ranking) || artifact.ranking.length !== evolvedIds.length ||
          evolvedIds.some(id => artifact.ranking.filter(entry => entry?.id === id && text(entry.reason)).length !== 1)) {
        throw new Error('Rank every evolved idea once and give each a reason.');
      }
      break;
    case 'methods': {
      const ids = round.ranking.ranking.slice(0, count).map(entry => entry.id);
      const selected = ideas(artifact.ideas, count);
      if (selected.length !== count || selected.some((idea, index) =>
        idea.id !== ids[index] || !text(idea.method))) {
        throw new Error('Provide a method for each selected idea in rank order.');
      }
      round.methods = selected;
      return;
    }
  }
  round[phase] = artifact;
}
