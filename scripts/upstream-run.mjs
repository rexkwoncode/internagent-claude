import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const pins = read(new URL('../upstream/revisions.json', import.meta.url));
const requestId = /^[a-f0-9]{32}$/;

function save(path, value) {
  const pending = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(pending, JSON.stringify(value) + '\n', { flag: 'wx' });
    renameSync(pending, path);
  } finally {
    rmSync(pending, { force: true });
  }
}

function run(directory, optionsFile) {
  const options = read(resolve(optionsFile));
  const { engine, checkout: location, python = 'python', args = [], config } = options;
  if (!['InternAgent', 'MLEvolve'].includes(engine) || typeof location !== 'string' || !location ||
      typeof python !== 'string' || !python || !Array.isArray(args) ||
      args.some(arg => typeof arg !== 'string') || (engine === 'InternAgent' &&
      ((config !== undefined && (typeof config !== 'string' || !config)) ||
       args.some(arg => /^--config(?:=|$)/.test(arg))))) {
    throw new Error('Expected engine, checkout, optional python and args, and optional InternAgent config.');
  }
  const input = dirname(resolve(optionsFile));
  const checkout = resolve(input, location);
  const pin = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' });
  if (pin.status !== 0 || pin.stdout.trim() !== pins[engine].commit) {
    throw new Error('Use the pinned ' + engine + ' checkout from upstream/revisions.json.');
  }
  const configPath = config && resolve(input, config);
  if (engine === 'InternAgent' && configPath && !existsSync(configPath)) {
    throw new Error('Missing InternAgent config: ' + configPath);
  }
  mkdirSync(dirname(directory), { recursive: true });
  mkdirSync(directory);
  const adapter = fileURLToPath(new URL('upstream-provider.py', import.meta.url));
  const argumentsForEngine = engine === 'InternAgent' ? [configPath ?? '-', ...args] : args;
  if (engine === 'InternAgent' && !args.some(arg => /^--exp_backend(?:=|$)/.test(arg))) {
    argumentsForEngine.push('--exp_backend', 'claudecode');
  }
  const child = spawnSync(python, [adapter, engine, checkout, directory, ...argumentsForEngine], {
    cwd: checkout, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', INTERNAGENT_PROJECT_ROOT: process.cwd() },
  });
  const outcome = { engine, exit: child.status, signal: child.signal, error: child.error?.message };
  save(join(directory, 'result.json'), outcome);
  process.exitCode = child.status ?? 1;
  return outcome;
}

function pending(directory) {
  if (!existsSync(directory)) return { pending: [], starting: true };
  const resultFile = join(directory, 'result.json');
  if (existsSync(resultFile)) return { pending: [], result: read(resultFile) };
  const requests = readdirSync(directory).flatMap(file => {
    const match = /^([a-f0-9]{32})\.request\.json$/.exec(file);
    return match && !existsSync(join(directory, match[1] + '.response.json')) ? [match[1]] : [];
  });
  return { pending: requests.map(id => {
    const path = join(directory, id + '.request.json');
    const { kind, model } = read(path);
    return { id, kind, model, path };
  }) };
}

async function wait(directory) {
  const deadline = Date.now() + 20_000;
  let state = pending(directory);
  while (!state.result && !state.pending.length && Date.now() < deadline) {
    await setTimeout(500);
    state = pending(directory);
  }
  return state;
}

function respond(directory, id, file) {
  if (!requestId.test(id ?? '') || !file) throw new Error('Provide the request ID and response file.');
  const request = read(join(directory, id + '.request.json'));
  const response = read(resolve(file));
  if (!response || typeof response !== 'object' ||
      (typeof response.error !== 'string' && (!Object.hasOwn(response, 'value') ||
      (['text', 'experiment'].includes(request.kind) && typeof response.value !== 'string') ||
      (request.kind === 'messages' && (!response.value || typeof response.value !== 'object'))))) {
    throw new Error('Respond with a JSON object containing a typed value or an error string.');
  }
  const path = join(directory, id + '.response.json');
  const lock = path + '.lock';
  mkdirSync(lock);
  try {
    if (existsSync(path)) throw new Error('This request was already answered.');
    save(path, response);
  } finally {
    rmdirSync(lock);
  }
  return { answered: id };
}

try {
  const [command, folder, other, file] = process.argv.slice(2);
  if (!folder || !['start', 'pending', 'respond'].includes(command) || (command === 'start' && !other)) {
    throw new Error('Usage: upstream-run.mjs start <mailbox> <options.json> | pending <mailbox> | respond <mailbox> <id> <response.json>');
  }
  const directory = resolve(folder);
  const result = command === 'start' ? run(directory, other) :
    command === 'pending' ? await wait(directory) : respond(directory, other, file);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
