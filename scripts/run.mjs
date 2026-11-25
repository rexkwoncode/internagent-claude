import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { recall } from './memory.mjs';
import { choose, leaderboard } from './search.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
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

function initialize(specFile, runDir) {
  const spec = validate(read(specFile));
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
  return { run: runDir, objective: spec.objective, trialBudget: spec.trials };
}

function withLock(runDir, action) {
  const lock = join(runDir, '.lock');
  let descriptor;
  try {
    descriptor = openSync(lock, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Run is locked. See README for interrupted-run recovery.');
    throw error;
  }
  try {
    writeFileSync(descriptor, String(process.pid));
    const stateFile = join(runDir, 'state.json');
    return action(read(stateFile), state => save(stateFile, state));
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
  const [exe, ...args] = state.spec[phase];
  const output = join(runDir, 'trials', trial.id, phase);
  mkdirSync(output, { recursive: true });
  const metricsFile = join(output, 'metrics.json');
  rmSync(metricsFile, { force: true });
  const child = spawnSync(exe, args, {
    cwd: state.taskDir,
    env: {
      ...process.env,
      INTERNAGENT_CANDIDATE: prepare(runDir, trial),
      INTERNAGENT_PHASE: phase,
      INTERNAGENT_OUTPUT: output,
      INTERNAGENT_METRICS: metricsFile,
    },
    encoding: 'utf8',
    timeout: state.spec.timeoutSeconds * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  writeFileSync(join(output, 'stdout.log'), child.stdout ?? '');
  writeFileSync(join(output, 'stderr.log'), child.stderr ?? '');
  const result = { status: 'failed', score: null, output };
  try {
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error('Evaluator exited with ' + (child.signal ?? child.status));
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
    metric: state.spec.metric,
    direction: state.spec.direction,
    attempted: state.trials.filter(t => t.status !== 'pending').length,
    trialBudget: state.spec.trials,
    best: top[0] ?? null,
    baseline: state.trials[0] ?? null,
    trials: state.trials,
    final: state.final ?? null,
  };
}

function main([command, pathArg, another, note]) {
  if (command === 'recall' && pathArg && another) {
    return recall(resolve(pathArg), another, note ? resolve(note) : undefined);
  }
  if (!['init', 'status', 'next', 'evaluate', 'finish'].includes(command) || !pathArg ||
      (['init', 'evaluate'].includes(command) && !another)) {
    throw new Error('Usage: run.mjs init <task.json> <run> | status <run> | next <run> | evaluate <run> <id> [note] | finish <run> | recall <runs-root> <objective> [current-run]');
  }
  const runDir = resolve(command === 'init' ? another : pathArg);
  if (command === 'init') return initialize(resolve(pathArg), runDir);
  if (command === 'status') return overview(read(join(runDir, 'state.json')));

  return withLock(runDir, (state, persist) => {
    let trial = state.trials.find(t => t.status === 'pending');
    if (command === 'next') {
      if (state.final) return { done: true, final: state.final };
      if (!trial) {
        const suggestion = choose(state.trials, state.spec.direction, state.spec.trials);
        if (!suggestion) return { done: true, ...overview(state) };
        trial = {
          id: String(state.trials.length).padStart(3, '0'),
          ...suggestion, status: 'pending',
        };
        state.trials.push(trial);
        persist(state);
      }
      return {
        ...trial,
        candidate: prepare(runDir, trial),
        parentCandidates: trial.parents.map(id => candidate(runDir, id)),
      };
    }
    if (command === 'evaluate') {
      if (!trial || trial.id !== another) throw new Error('Evaluate the current pending trial returned by next.');
      Object.assign(trial, evaluate(runDir, state, trial, 'validation'), { note: note ?? '' });
      persist(state);
      return trial;
    }
    if (state.final && state.final.holdout?.status !== 'failed') return state.final;
    if (trial) throw new Error('Evaluate the pending trial before finalizing.');
    if (choose(state.trials, state.spec.direction, state.spec.trials)) {
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
    persist(state);
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
