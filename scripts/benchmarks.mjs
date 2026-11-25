import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const catalog = read(new URL('../upstream/task-catalog.json', import.meta.url));
const localTasks = Object.fromEntries(Object.entries(catalog).filter(([, task]) => task.mode === 'research-task'));
const algorithmTasks = Object.fromEntries(Object.entries(catalog).filter(([, task]) => task.mode !== 'research-task'));
const papers = read(new URL('../upstream/researchclawbench-task-index.json', import.meta.url));
const defaults = {
  argv: ['bash', '{launcher}'],
  cwd: '.',
  resultFile: 'final_info.json',
};

function inspect(folder) {
  if (existsSync(join(folder, 'task_info.json'))) return { mode: 'reproduce', folder };
  const prompt = join(folder, 'prompt.json');
  if (!existsSync(prompt)) throw new Error('Expected prompt.json or task_info.json in ' + folder);
  const id = basename(folder);
  const profile = Object.hasOwn(algorithmTasks, id) ? algorithmTasks[id] : {};
  return { id, folder, prompt, ...profile, mode: profile.mode ?? (profile.metricPath ? 'benchmark' : 'custom-evaluator') };
}

function inside(root, value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) throw new Error(label + ' must be relative.');
  const full = resolve(root, value);
  const path = relative(root, full);
  if (path === '..' || isAbsolute(path) || path.startsWith('..' + sep)) {
    throw new Error(label + ' must remain in the benchmark workspace.');
  }
  return full;
}

function checkContract(contract) {
  if (!contract || !Array.isArray(contract.argv) || !contract.argv.length ||
      !contract.argv.every(arg => typeof arg === 'string' && arg && !arg.includes('\0')) ||
      !Array.isArray(contract.metricPath) || !contract.metricPath.length ||
      !contract.metricPath.every(key => typeof key === 'string' && key)) {
    throw new Error('A benchmark needs an argv command and a metricPath array.');
  }
  inside(process.cwd(), contract.cwd, 'cwd');
  inside(process.cwd(), contract.resultFile, 'resultFile');
  return contract;
}

function prepare(folder, destination, options = {}) {
  const info = inspect(folder);
  if (info.mode === 'research' || info.mode === 'reproduce') return info;
  if (info.mode === 'custom-evaluator' && !options.validation?.argv) {
    throw new Error(info.id + ' requires a local evaluator command and a result JSON contract.');
  }
  const { argv, cwd, resultFile, metricPath, numericString } = { ...defaults, ...info };
  const validation = checkContract({ argv, cwd, resultFile, metricPath, numericString, ...options.validation });
  const holdout = options.holdout === undefined ? undefined : checkContract({ ...validation, ...options.holdout });
  const metric = options.metric ?? info.metric ?? validation.metricPath.at(-1);
  const direction = options.direction ?? info.direction;
  if (typeof metric !== 'string' || !metric.trim() || !['minimize', 'maximize'].includes(direction)) {
    throw new Error('Provide a metric name and a minimize or maximize direction.');
  }
  if (existsSync(destination)) throw new Error('Benchmark destination already exists.');
  const prompt = read(info.prompt);
  const objective = options.objective ?? prompt.goal ?? prompt.task_description;
  if (typeof objective !== 'string' || !objective.trim()) throw new Error('Benchmark objective is missing.');

  const seed = join(folder, 'code');
  const launcher = join(folder, 'launcher.sh');
  if (!existsSync(seed)) throw new Error('Benchmark code directory is missing: ' + seed);
  if (!existsSync(launcher) && [validation, holdout].some(item => item?.argv.includes('{launcher}'))) {
    throw new Error('Benchmark launcher is missing: ' + launcher);
  }
  const configure = join(destination, 'benchmark.json');
  const spec = {
    objective, seed: 'seed', metric, direction, constraints: options.constraints ?? prompt.constraints,
    validation: [process.execPath, script, 'evaluate', configure],
    holdout: holdout ? [process.execPath, script, 'evaluate', configure] : undefined,
    trials: options.trials ?? 3,
    timeoutSeconds: options.timeoutSeconds ?? (info.id === 'AutoDebug' ? 120 : 3600),
    models: options.models,
  };
  const staging = destination + '.' + randomUUID() + '.prepare';
  mkdirSync(staging, { recursive: true });
  try {
    cpSync(seed, join(staging, 'seed', 'code'), { recursive: true });
    if (existsSync(launcher)) cpSync(launcher, join(staging, 'launcher.sh'));
    cpSync(info.prompt, join(staging, 'upstream-prompt.json'));
    writeFileSync(join(staging, 'benchmark.json'), JSON.stringify({ metric, validation, holdout }, null, 2));
    writeFileSync(join(staging, 'task.json'), JSON.stringify(spec, null, 2));
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { ...info, taskSpec: join(destination, 'task.json'), metric, direction, holdout: Boolean(holdout) };
}

export function metricValue(payload, keys, numericString = false) {
  let value = payload;
  for (const key of keys) {
    value = value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
  }
  if (numericString && typeof value === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value.trim())) {
    value = Number(value);
  }
  if (!Number.isFinite(value)) throw new Error('Expected a finite benchmark score at ' + JSON.stringify(keys));
  return value;
}

async function execute(argv, cwd, logs, timeout) {
  const windows = process.platform === 'win32';
  const child = spawn(argv[0], argv.slice(1), { cwd, detached: !windows, windowsHide: true, stdio: ['ignore', ...logs] });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    if (windows) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL');
      }
    }
  }, timeout);
  try {
    const result = await new Promise((resolveRun, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolveRun(status ?? signal));
    });
    if (expired) throw new Error('Benchmark command timed out. See the benchmark logs.');
    if (result !== 0) throw new Error('Benchmark command exited with ' + result + '. See the benchmark logs.');
  } finally {
    clearTimeout(timer);
  }
}

async function evaluate(configFile) {
  const { INTERNAGENT_CANDIDATE: candidate, INTERNAGENT_OUTPUT: output, INTERNAGENT_PHASE: phase,
    INTERNAGENT_METRICS: metrics, INTERNAGENT_TIMEOUT_SECONDS: seconds } = process.env;
  if (!candidate || !output || !metrics || !['validation', 'holdout'].includes(phase)) {
    throw new Error('Run benchmark evaluation through the InternAgent runner.');
  }
  const started = Date.now();
  const config = read(configFile);
  const contract = checkContract(config[phase]);
  const workspace = join(output, 'benchmark-' + randomUUID());
  cpSync(candidate, workspace, { recursive: true });
  const cwd = inside(workspace, contract.cwd, 'cwd');
  const result = inside(workspace, contract.resultFile, 'resultFile');
  if (existsSync(result)) throw new Error('Remove pre-existing benchmark metrics from the seed: ' + result);
  const out = join(workspace, 'run_output');
  mkdirSync(out);
  const tokens = new Map([
    ['{launcher}', join(dirname(configFile), 'launcher.sh').split(sep).join('/')],
    ['{output}', relative(cwd, out).split(sep).join('/')],
    ['{workspace}', workspace],
  ]);
  const args = contract.argv.map(arg => tokens.get(arg) ?? arg);
  const logs = [openSync(join(output, 'benchmark.stdout.log'), 'w')];
  try {
    logs.push(openSync(join(output, 'benchmark.stderr.log'), 'w'));
    const ms = Number(seconds ?? 3600) * 1000;
    const budget = ms - Math.min(2000, ms / 4) - (Date.now() - started);
    if (budget <= 0) throw new Error('Benchmark workspace setup exhausted the timeout.');
    await execute(args, cwd, logs, budget);
    const score = metricValue(read(result), contract.metricPath, contract.numericString);
    writeFileSync(metrics, JSON.stringify({ [config.metric]: score }));
  } finally {
    for (const fd of logs) closeSync(fd);
  }
}

async function main([command, source, destination, options]) {
  if (command === 'list') return { algorithmTasks, paperTasks: papers, localTasks };
  if (command === 'bundled' && Object.hasOwn(localTasks, source)) {
    const task = localTasks[source];
    const taskSpec = fileURLToPath(new URL('../' + task.demoTaskSpec, import.meta.url));
    if (!existsSync(taskSpec)) throw new Error('Bundled task spec is missing: ' + taskSpec);
    return { ...task, taskSpec };
  }
  if (command === 'inspect' && source) return inspect(resolve(source));
  if (command === 'prepare' && source && destination) {
    return prepare(resolve(source), resolve(destination), options ? read(resolve(options)) : undefined);
  }
  if (command === 'evaluate' && source) return evaluate(resolve(source));
  throw new Error('Usage: benchmarks.mjs list | bundled <task-id> | inspect <task-folder> | prepare <task-folder> <destination> [options.json]');
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    const result = await main(process.argv.slice(2));
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
