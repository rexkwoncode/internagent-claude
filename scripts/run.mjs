import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { recall } from './memory.mjs';
import { leaderboard } from './search.mjs';
import { advance, recordPhase, validateDiscovery } from './discovery.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const modelRoles = ['planner', 'builder', 'reviewer'];
const modelKeys = ['default', ...modelRoles];
const modelAliases = ['inherit', 'haiku', 'sonnet', 'opus', 'fable'];

function validateModels(models, label = 'models') {
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    throw new Error(label + ' must be an object.');
  }
  for (const [role, alias] of Object.entries(models)) {
    if (!modelKeys.includes(role)) throw new Error('Unknown ' + label + ' key: ' + role);
    if (!modelAliases.includes(alias)) {
      throw new Error(label + '.' + role + ' must be one of: ' + modelAliases.join(', '));
    }
  }
  return models;
}

function readModelConfig(file) {
  try {
    const config = read(file);
    validateModels(config?.models, 'models in ' + file);
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return { models: {} };
    if (error instanceof SyntaxError) throw new Error('Invalid JSON in ' + file + ': ' + error.message);
    throw error;
  }
}

function configPaths() {
  const user = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return { project: resolve('internagent.config.json'), user: resolve(user, 'internagent.json') };
}

function resolveModels(...layers) {
  return Object.fromEntries(modelRoles.map(role => {
    const alias = layers.map(layer => layer[role] ?? layer.default).find(value => value !== undefined);
    return [role, alias ?? 'inherit'];
  }));
}

function effectiveModels(taskModels) {
  const task = taskModels === undefined ? {} : validateModels(taskModels);
  const { project, user } = configPaths();
  return resolveModels(task, readModelConfig(project).models, readModelConfig(user).models);
}

function configure(scope, role, alias) {
  if (!['user', 'project'].includes(scope) || !modelKeys.includes(role) ||
      (alias !== 'clear' && !modelAliases.includes(alias))) {
    throw new Error('Usage: run.mjs configure <user|project> <default|planner|builder|reviewer> <' +
      [...modelAliases, 'clear'].join('|') + '>');
  }
  const file = configPaths()[scope];
  mkdirSync(dirname(file), { recursive: true });
  return withLock(file + '.lock', 'Model config is locked by another write.', () => {
    const config = readModelConfig(file);
    if (alias === 'clear') delete config.models[role];
    else config.models[role] = alias;
    save(file, config);
    return { file, scope, models: config.models };
  });
}

function save(file, value) {
  const pending = file + '.' + randomUUID() + '.tmp';
  writeFileSync(pending, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  renameSync(pending, file);
}

function validate(spec) {
  const argv = value => Array.isArray(value) && value.length > 0 &&
    value.every(arg => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0'));
  if (!spec || typeof spec.objective !== 'string' || !spec.objective.trim() ||
      typeof spec.metric !== 'string' || !spec.metric.trim() ||
      !['minimize', 'maximize'].includes(spec.direction) ||
      typeof spec.seed !== 'string' || !spec.seed || !argv(spec.validation) ||
      (spec.holdout !== undefined && !argv(spec.holdout))) {
    throw new Error('Specify objective, seed, metric, direction, validation argv, and optional holdout argv.');
  }
  if (spec.type !== undefined && spec.type !== 'experiment' && spec.type !== 'algorithm-engineering') {
    throw new Error('Task type must be experiment or algorithm-engineering.');
  }
  if (spec.type === 'algorithm-engineering' && !argv(spec.correctness)) {
    throw new Error('An algorithm-engineering task requires a correctness command as an argv array.');
  }
  for (const [key, max, fallback] of [['trials', 1000, 6], ['timeoutSeconds', 86400, 300]]) {
    spec[key] ??= fallback;
    if (!Number.isInteger(spec[key]) || spec[key] < 1 || spec[key] > max) {
      throw new Error(key + ' must be an integer between 1 and ' + max);
    }
  }
  return spec;
}

function snapshot(source, target) {
  cpSync(source, target, {
    recursive: true,
    filter(path) {
      if (lstatSync(path).isSymbolicLink()) throw new Error('Keep symbolic links outside the candidate tree: ' + path);
      return true;
    },
  });
}

function initialize(specFile, runDir, profile) {
  const spec = validate(read(specFile));
  if (spec.discovery === undefined && profile === 'discovery') spec.discovery = {};
  spec.discovery = validateDiscovery(spec.discovery, spec.trials);
  spec.models = effectiveModels(spec.models);
  const taskDir = dirname(specFile);
  const seed = realpathSync(resolve(taskDir, spec.seed));
  if (!statSync(seed).isDirectory()) throw new Error('Seed must be a directory.');
  const relativeRun = relative(seed, runDir);
  if (!relativeRun || (!isAbsolute(relativeRun) && relativeRun !== '..' && !relativeRun.startsWith('..' + sep))) {
    throw new Error('Put the run outside the seed directory.');
  }
  mkdirSync(dirname(runDir), { recursive: true });
  const staging = runDir + '.' + randomUUID() + '.init';
  mkdirSync(staging);
  try {
    snapshot(seed, join(staging, 'seed'));
    save(join(staging, 'state.json'), { version: 1, taskDir, spec, trials: [] });
    if (existsSync(runDir)) throw new Error('Run already exists. Choose a new run path or use status.');
    renameSync(staging, runDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return {
    run: runDir, objective: spec.objective, type: spec.type ?? 'experiment', constraints: spec.constraints,
    trialBudget: spec.trials, models: spec.models, discovery: spec.discovery,
  };
}

function withLock(lock, lockedMessage, action) {
  let descriptor;
  try {
    descriptor = openSync(lock, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(lockedMessage);
    throw error;
  }
  try {
    writeFileSync(descriptor, String(process.pid));
    return action();
  } finally {
    closeSync(descriptor);
    rmSync(lock);
  }
}

function candidate(runDir, id) {
  return join(runDir, 'trials', id, 'candidate');
}

function prepare(runDir, trial) {
  const target = candidate(runDir, trial.id);
  if (existsSync(target)) return target;
  const source = trial.parents.length ? candidate(runDir, trial.parents[0]) : join(runDir, 'seed');
  mkdirSync(dirname(target), { recursive: true });
  const staging = target + '.' + randomUUID() + '.copy';
  try {
    snapshot(source, staging);
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

function evaluate(runDir, state, trial, phase) {
  const output = join(runDir, 'trials', trial.id, phase);
  mkdirSync(output, { recursive: true });
  const metricsFile = join(output, 'metrics.json');
  rmSync(metricsFile, { force: true });
  const deadline = performance.now() + state.spec.timeoutSeconds * 1000;
  const options = {
    cwd: state.taskDir,
    env: {
      ...process.env,
      INTERNAGENT_CANDIDATE: prepare(runDir, trial),
      INTERNAGENT_PHASE: phase,
      INTERNAGENT_OUTPUT: output,
      INTERNAGENT_METRICS: metricsFile,
    },
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  };
  function execute([exe, ...args], prefix) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error('Evaluation exhausted its time budget.');
    const child = spawnSync(exe, args, {
      ...options, timeout: remaining,
      env: { ...options.env, INTERNAGENT_TIMEOUT_SECONDS: String(remaining / 1000) },
    });
    writeFileSync(join(output, prefix + 'stdout.log'), child.stdout ?? '');
    writeFileSync(join(output, prefix + 'stderr.log'), child.stderr ?? '');
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error('Evaluator exited with ' + (child.signal ?? child.status));
  }
  const result = { status: 'failed', score: null, output };
  try {
    if (state.spec.type === 'algorithm-engineering') {
      try {
        execute(state.spec.correctness, 'correctness.');
      } catch (error) {
        throw new Error('Correctness check failed: ' + error.message);
      }
      rmSync(metricsFile, { force: true });
    }
    execute(state.spec[phase], '');
    const metrics = read(metricsFile);
    const score = Object.hasOwn(metrics, state.spec.metric) ? metrics[state.spec.metric] : null;
    if (!Number.isFinite(score)) throw new Error('Expected a finite number for metric ' + state.spec.metric);
    return { ...result, status: 'ok', score, metrics };
  } catch (error) {
    return { ...result, error: error.code === 'ENOENT' && !existsSync(metricsFile)
      ? 'Evaluator or metrics file missing: ' + error.message : error.message };
  }
}

function overview(state) {
  const top = leaderboard(state.trials, state.spec.direction);
  return {
    objective: state.spec.objective,
    type: state.spec.type ?? 'experiment',
    constraints: state.spec.constraints,
    metric: state.spec.metric,
    direction: state.spec.direction,
    models: resolveModels(state.spec.models ?? {}),
    attempted: state.trials.filter(t => t.status !== 'pending').length,
    trialBudget: state.spec.trials,
    best: top[0] ?? null,
    baseline: state.trials[0] ?? null,
    trials: state.trials,
    discovery: state.spec.discovery,
    rounds: state.rounds ?? [],
    final: state.final ?? null,
  };
}

function main([command, pathArg, another, note]) {
  if (command === 'configure') return configure(pathArg, another, note);
  if (command === 'models') return effectiveModels(pathArg ? read(resolve(pathArg))?.models : undefined);
  if (command === 'recall' && pathArg && another) {
    return recall(resolve(pathArg), another, note ? resolve(note) : undefined);
  }
  if (!['init', 'status', 'next', 'stage', 'evaluate', 'finish'].includes(command) || !pathArg ||
      (['init', 'evaluate', 'stage'].includes(command) && !another) || (command === 'stage' && !note) ||
      (command === 'init' && note !== undefined && note !== 'discovery')) {
    throw new Error('Usage: run.mjs init <task.json> <run> [discovery] | models [task.json] | configure <scope> <role> <alias> | status <run> | next <run> | stage <run> <phase> <artifact.json> | evaluate <run> <id> [note] | finish <run> | recall <runs-root> <objective> [current-run]');
  }
  const runDir = resolve(command === 'init' ? another : pathArg);
  if (command === 'init') return initialize(resolve(pathArg), runDir, note);
  if (command === 'status') return overview(read(join(runDir, 'state.json')));

  return withLock(join(runDir, '.lock'), 'Run is locked. See README for interrupted-run recovery.', () => {
    const stateFile = join(runDir, 'state.json');
    const state = read(stateFile);
    const persist = () => save(stateFile, state);
    let trial = state.trials.find(t => t.status === 'pending');
    if (command === 'stage') {
      if (state.final || trial || !state.spec.discovery) throw new Error('There is no pending discovery phase.');
      recordPhase(state, another, read(resolve(note)));
      persist();
      return { recorded: another, round: state.rounds.at(-1).number };
    }
    if (command === 'next') {
      if (state.final) return { done: true, final: state.final };
      if (!trial) {
        const suggestion = advance(state);
        if (!suggestion) return { done: true, ...overview(state) };
        if (suggestion.phase) {
          persist();
          return { ...suggestion, baseCandidate: candidate(runDir, suggestion.base) };
        }
        trial = {
          id: String(state.trials.length).padStart(3, '0'),
          ...suggestion, status: 'pending',
        };
        state.trials.push(trial);
        persist();
      }
      return {
        ...trial,
        hypothesis: trial.idea ? state.rounds?.find(round => round.number === trial.round)
          ?.methods.find(idea => idea.id === trial.idea) : undefined,
        candidate: prepare(runDir, trial),
        parentCandidates: trial.parents.map(id => candidate(runDir, id)),
      };
    }
    if (command === 'evaluate') {
      if (!trial || trial.id !== another) throw new Error('Evaluate the current pending trial returned by next.');
      Object.assign(trial, evaluate(runDir, state, trial, 'validation'), { note: note ?? '' });
      persist();
      return trial;
    }
    if (state.final && state.final.holdout?.status !== 'failed') return state.final;
    if (trial) throw new Error('Evaluate the pending trial before finalizing.');
    if (advance(state)) {
      throw new Error('Complete the search budget before evaluating the holdout.');
    }
    const best = leaderboard(state.trials, state.spec.direction)[0];
    if (!best) throw new Error('No successful validation candidate. Inspect baseline logs.');
    state.final = {
      winner: best.id,
      candidate: candidate(runDir, best.id),
      validation: best.score,
      holdout: state.spec.holdout ? evaluate(runDir, state, best, 'holdout') : null,
    };
    persist();
    return state.final;
  });
}

try {
  const result = main(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
