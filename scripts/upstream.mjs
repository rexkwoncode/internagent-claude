import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const sources = JSON.parse(readFileSync(new URL('../upstream/revisions.json', import.meta.url), 'utf8'));

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Git failed: ' + args[0]);
  return result.stdout.trim();
}

function main([name, destination, task]) {
  if (!Object.hasOwn(sources, name) || !destination || (task &&
      (name !== 'ResearchClawBench' || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(task)))) {
    throw new Error('Usage: upstream.mjs <InternAgent|MLEvolve|ResearchClawBench> <destination> [ResearchClawBench-task]');
  }
  const { url, commit } = sources[name];
  const target = resolve(destination);
  try {
    statSync(target);
    if (git(target, 'rev-parse', 'HEAD') !== commit) throw new Error('Destination exists at a different revision.');
    if (task) statSync(join(target, 'tasks', task, 'task_info.json'));
    return target;
  } catch (error) {
    if (error.code !== 'ENOENT' || error.path !== target) throw error;
  }

  mkdirSync(dirname(target), { recursive: true });
  const temporary = mkdtempSync(join(dirname(target), '.upstream-'));
  try {
    git(temporary, 'init', '-q');
    git(temporary, 'remote', 'add', 'origin', url);
    git(temporary, 'config', 'remote.origin.promisor', 'true');
    git(temporary, 'config', 'remote.origin.partialclonefilter', 'blob:none');
    git(temporary, 'fetch', '--depth=1', '--filter=blob:none', 'origin', commit);
    if (task) git(temporary, 'sparse-checkout', 'set', 'tasks/' + task);
    git(temporary, 'checkout', '-q', '--detach', 'FETCH_HEAD');
    if (git(temporary, 'rev-parse', 'HEAD') !== commit) throw new Error('Fetched revision did not match the pin.');
    if (task) statSync(join(temporary, 'tasks', task, 'task_info.json'));
    renameSync(temporary, target);
    return target;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  console.log(main(process.argv.slice(2)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
