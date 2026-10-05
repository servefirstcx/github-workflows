import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, existsSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** The shell of one workflow step, exactly as the runner gets it (steps pass inputs through env). */
function stepScript(file, name) {
  const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name:')[0];
  assert.ok(step, `${file} has step "${name}"`);
  assert.doesNotMatch(step.split('        run: |\n')[1], /\$\{\{/, 'inputs reach the script through env, not interpolation');
  return step.split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n');
}
const syncScript = stepScript('sync-release.yml', 'Merge main into stage').replace(/sleep \$\(\(attempt \* 5\)\)/, 'true');
const backstopScript = stepScript('release.yml', 'Include main history missing from stage');
const leadPrScript = stepScript('sync-release.yml', 'Open sync PR for a lead');

function repoFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sync-release-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const remote = join(root, 'remote.git'), seed = join(root, 'seed'), runner = join(root, 'runner');
  const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const commit = (branch, file, content, message) => {
    git(seed, 'checkout', '-q', branch); writeFileSync(join(seed, file), content);
    git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', message); git(seed, 'push', '-q', 'origin', branch);
  };
  git(root, 'init', '-q', '--bare', remote); git(root, 'init', '-q', '-b', 'main', seed);
  git(seed, 'config', 'user.email', 'test@example.invalid'); git(seed, 'config', 'user.name', 'Test');
  git(seed, 'remote', 'add', 'origin', remote);
  writeFileSync(join(seed, 'package.json'), '{\n  "name": "fixture",\n  "version": "1.2.0"\n}\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'release 1.2.0'); git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'stage'); git(seed, 'push', '-q', 'origin', 'stage');
  git(root, 'clone', '-q', remote, runner);
  const output = join(root, 'output'), summary = join(root, 'summary');
  const run = (script, env, cwd = runner) => {
    writeFileSync(output, ''); writeFileSync(summary, '');
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {cwd, encoding: 'utf8', env: {...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env}});
    return {...result, outputs: Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map(line => line.split('='))), summary: readFileSync(summary, 'utf8')};
  };
  const sync = (env = {}) => run(syncScript, {MAIN_BRANCH: 'main', STAGING_BRANCH: 'stage', VERSION: '1.2.1', HAS_RELEASE_TOKEN: 'true', ...env});
  const remoteSha = ref => git(remote, 'rev-parse', `refs/heads/${ref}`);
  const isAncestor = (ancestor, of) => spawnSync('git', ['merge-base', '--is-ancestor', ancestor, of], {cwd: remote}).status === 0;
  const rejectPushes = count => {
    const hook = join(remote, 'hooks', 'pre-receive'), counter = join(root, 'rejected');
    writeFileSync(hook, `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0)\nif [ "$n" -lt ${count} ]; then echo $((n+1)) > "${counter}"; echo "rejected by test" >&2; exit 1; fi\n`);
    chmodSync(hook, 0o755);
  };
  return {root, remote, seed, runner, git, commit, run, sync, remoteSha, isAncestor, rejectPushes};
}

test('sync: a released main is merged into stage as a real merge commit, keeping stage work', t => {
  const f = repoFixture(t);
  f.commit('main', 'package.json', '{\n  "name": "fixture",\n  "version": "1.2.1"\n}\n', 'hotfix 1.2.1');
  f.commit('stage', 'feature.txt', 'new work\n', 'feature on stage');
  const stageBefore = f.remoteSha('stage'), mainSha = f.remoteSha('main');
  const result = f.sync();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.outputs.result, 'merged');
  const head = f.remoteSha('stage');
  assert.deepEqual(f.git(f.remote, 'rev-list', '--parents', '-n', '1', head).split(' ').slice(1), [stageBefore, mainSha], 'merge commit: stage first, main second');
  assert.ok(f.isAncestor(mainSha, head), 'main is in stage history');
  assert.match(f.git(f.remote, 'log', '-1', '--format=%s', head), /Sync release v1\.2\.1 from main back to stage/);
  assert.equal(f.remoteSha('main'), mainSha, 'main is never written');
});

test('sync: nothing to do when stage already contains main', t => {
  const f = repoFixture(t);
  f.commit('stage', 'feature.txt', 'new work\n', 'feature on stage');
  const before = f.remoteSha('stage');
  const result = f.sync();
  assert.equal(result.outputs.result, 'in-sync');
  assert.equal(f.remoteSha('stage'), before);
});

test('sync: conflicts and a missing token leave stage untouched for a lead', t => {
  const f = repoFixture(t);
  f.commit('main', 'package.json', '{\n  "name": "fixture",\n  "version": "1.2.1"\n}\n', 'hotfix 1.2.1');
  const before = f.remoteSha('stage');
  const noToken = f.sync({HAS_RELEASE_TOKEN: 'false'});
  assert.equal(noToken.outputs.result, 'no-token');
  f.commit('stage', 'package.json', '{\n  "name": "fixture",\n  "version": "1.3.0-dev"\n}\n', 'conflicting stage change');
  const conflicted = f.remoteSha('stage');
  const conflict = f.sync();
  assert.equal(conflict.status, 0, conflict.stderr);
  assert.equal(conflict.outputs.result, 'conflict');
  assert.equal(f.remoteSha('stage'), conflicted, 'a conflicted merge is never pushed');
  assert.ok(!existsSync(join(f.runner, '.git', 'MERGE_HEAD')), 'the failed merge is aborted');
  assert.notEqual(before, conflicted);
});

test('sync: a rejected push is retried, and gives up after three attempts', t => {
  const f = repoFixture(t);
  f.commit('main', 'hotfix.txt', 'fix\n', 'hotfix 1.2.1');
  f.rejectPushes(1);
  const retried = f.sync();
  assert.equal(retried.outputs.result, 'merged', retried.stderr);
  assert.ok(f.isAncestor(f.remoteSha('main'), f.remoteSha('stage')));
  const g = repoFixture(t);
  g.commit('main', 'hotfix.txt', 'fix\n', 'hotfix 1.2.1');
  const before = g.remoteSha('stage');
  g.rejectPushes(3);
  const failed = g.sync();
  assert.equal(failed.outputs.result, 'push-failed');
  assert.equal(g.remoteSha('stage'), before);
});

test('release backstop: stage missing main history gets it merged before the version is read', t => {
  const f = repoFixture(t);
  f.commit('stage', 'feature.txt', 'new work\n', 'feature on stage');
  // A hotfix bumped the version on main, and its sync was never merged.
  f.commit('main', 'package.json', '{\n  "name": "fixture",\n  "version": "1.2.1"\n}\n', 'hotfix 1.2.1');
  f.git(f.runner, 'fetch', '-q', 'origin'); f.git(f.runner, 'checkout', '-q', '-B', 'stage', 'origin/stage');
  f.git(f.runner, 'config', 'user.email', 'bot@example.invalid'); f.git(f.runner, 'config', 'user.name', 'Bot');
  const backstop = () => f.run(backstopScript, {MAIN_BRANCH: 'main', STAGING_BRANCH: 'stage'});
  const repaired = backstop();
  assert.equal(repaired.status, 0, repaired.stderr + repaired.stdout);
  assert.match(repaired.stdout, /::warning::stage was missing 1 commit\(s\) from main/);
  assert.match(repaired.summary, /missing 1 commit\(s\)/);
  assert.equal(f.git(f.runner, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'), '');
  assert.equal(JSON.parse(readFileSync(join(f.runner, 'package.json'), 'utf8')).version, '1.2.1', 'the hotfix version is seen');
  assert.equal(readFileSync(join(f.runner, 'feature.txt'), 'utf8'), 'new work\n');
  const head = f.git(f.runner, 'rev-parse', 'HEAD');
  const again = backstop();
  assert.match(again.stdout, /stage contains main/);
  assert.equal(f.git(f.runner, 'rev-parse', 'HEAD'), head, 'nothing to repair the second time');
});

test('release backstop: conflicting missing history stops the release with instructions', t => {
  const f = repoFixture(t);
  f.commit('main', 'package.json', '{\n  "name": "fixture",\n  "version": "1.2.1"\n}\n', 'hotfix 1.2.1');
  f.commit('stage', 'package.json', '{\n  "name": "fixture",\n  "version": "1.3.0-dev"\n}\n', 'conflicting stage change');
  f.git(f.runner, 'fetch', '-q', 'origin'); f.git(f.runner, 'checkout', '-q', '-B', 'stage', 'origin/stage');
  f.git(f.runner, 'config', 'user.email', 'bot@example.invalid'); f.git(f.runner, 'config', 'user.name', 'Bot');
  const head = f.git(f.runner, 'rev-parse', 'HEAD');
  const stopped = f.run(backstopScript, {MAIN_BRANCH: 'main', STAGING_BRANCH: 'stage'});
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stdout, /::error::stage is missing 1 commit\(s\) from main and they conflict/);
  assert.equal(f.git(f.runner, 'rev-parse', 'HEAD'), head);
  assert.ok(!existsSync(join(f.runner, '.git', 'MERGE_HEAD')));
});

test('lead PR: opened even when the token cannot manage labels, and an open one is reused', t => {
  const root = mkdtempSync(join(tmpdir(), 'sync-lead-pr-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const log = join(root, 'gh.log'), output = join(root, 'output'), existing = join(root, 'existing');
  // A stand-in gh: label commands are refused, as for a GITHUB_TOKEN without issues permission.
  writeFileSync(join(root, 'gh'), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1 $2" in\n  "label create"|"pr edit") echo "HTTP 403" >&2; exit 1 ;;\n  "pr list") cat "${existing}" 2>/dev/null; exit 0 ;;\n  "pr create") echo "https://github.com/org/repo/pull/42" ;;\nesac\n`);
  chmodSync(join(root, 'gh'), 0o755);
  const open = result => {
    writeFileSync(output, '');
    const run = spawnSync('bash', ['-eo', 'pipefail', '-c', leadPrScript], {cwd: root, encoding: 'utf8',
      env: {...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_OUTPUT: output, MAIN_BRANCH: 'main', STAGING_BRANCH: 'stage', VERSION: '1.2.1', RESULT: result}});
    return {...run, output: readFileSync(output, 'utf8'), body: existsSync(join(root, 'pr_body.md')) ? readFileSync(join(root, 'pr_body.md'), 'utf8') : ''};
  };
  const opened = open('no-token');
  assert.equal(opened.status, 0, opened.stderr + opened.stdout);
  assert.equal(opened.output, 'PR_NUMBER=42\n');
  assert.match(opened.stdout, /::warning::Release v1\.2\.1 was not synced back to stage automatically/);
  assert.match(opened.stdout, /::notice::The sync PR was opened without labels/);
  assert.match(opened.body, /Never squash it/);
  assert.match(readFileSync(log, 'utf8'), /^pr create --base stage --head main /m);
  const conflict = open('conflict');
  assert.match(conflict.body, /conflict editor can't be used/);
  writeFileSync(existing, '17\n');
  const reused = open('conflict');
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(reused.output, 'PR_NUMBER=17\n');
  assert.equal(readFileSync(log, 'utf8').match(/^pr create/gm).length, 2, 'no second PR when one is open');
});
