import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const stepOf = name => {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name:')[0];
  assert.ok(step, `${name} step exists`);
  return step;
};
const scriptOf = name => {
  const block = stepOf(name).match(/          script: \|\n((?: {12}[^\n]*\n|\n)+)/)?.[1];
  assert.ok(block, `${name} script exists`);
  const source = block.split('\n').map(line => line.slice(12)).join('\n');
  return new (Object.getPrototypeOf(async function() {}).constructor)('require', 'github', 'context', 'core', source);
};
const withEnv = async (vars, fn) => {
  const old = {...process.env};
  Object.assign(process.env, vars);
  try { return await fn(); }
  finally { for (const key of Object.keys(vars)) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key]; }
};

// ---- Find a closed release that never shipped ----
const sha = 'a'.repeat(40);
const prOf = extra => ({number: 4, state: 'closed', merged_at: null, head: {ref: 'release/1.2.3', sha, repo: {full_name: 'example/app'}},
  base: {ref: 'main', repo: {full_name: 'example/app'}}, ...extra});
async function find(prs, tags = [], tagError) {
  const outputs = {};
  const github = {rest: {pulls: {list: async () => ({data: prs})}, git: {getRef: async ({ref}) => {
    if (tagError) throw Object.assign(new Error('tag lookup'), {status: tagError});
    if (tags.includes(ref.replace('tags/', ''))) return {data: {ref}};
    throw Object.assign(new Error('missing'), {status: 404});
  }}}};
  github.paginate = async (method, args) => (await method(args)).data;
  await withEnv({VERSION: '1.2.3', MAIN_BRANCH: 'main'}, () => scriptOf('Find a closed release that never shipped')(
    () => { throw new Error('no require'); }, github, {repo: {owner: 'example', repo: 'app'}},
    {setOutput: (k, v) => outputs[k] = v, info: () => {}}));
  return outputs;
}

test('a single closed, unmerged, untagged release PR is picked for reopening', async () => {
  assert.deepEqual(await find([prOf()]), {pr_number: '4', old_head: sha});
});

for (const [name, prs, tags] of [
  ['no PR', [], []],
  ['an open PR', [prOf({state: 'open'})], []],
  ['a merged PR', [prOf({merged_at: '2026-10-19T00:00:00Z'})], []],
  ['two PRs', [prOf(), prOf({number: 5})], []],
  ['a v-tag', [prOf()], ['v1.2.3']],
  ['a bare tag', [prOf()], ['1.2.3']],
  ['a fork PR', [prOf({head: {ref: 'release/1.2.3', sha, repo: {full_name: 'fork/app'}}})], []],
  ['a PR into another base', [prOf({base: {ref: 'stage', repo: {full_name: 'example/app'}}})], []],
]) {
  test(`nothing is reopened for ${name}`, async () => {
    assert.deepEqual(await find(prs, tags), {});
  });
}

test('a failing tag lookup stops the run instead of reopening', async () => {
  await assert.rejects(find([prOf()], [], 500), /tag lookup/);
});

// ---- Restore the closed release (real git, fake gh) ----
function restoreFixture(t, {reopen = 'ok'} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-reopen-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const remote = join(root, 'remote.git'), seed = join(root, 'seed'), runner = join(root, 'runner'), bin = join(root, 'bin');
  const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const commit = (cwd, file, text, message) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); return git(cwd, 'rev-parse', 'HEAD'); };
  git(root, 'init', '--bare', remote); git(root, 'init', '-b', 'stage', seed);
  git(seed, 'config', 'user.email', 'test@example.invalid'); git(seed, 'config', 'user.name', 'Test');
  writeFileSync(join(seed, 'package.json'), '{\n  "name": "fixture",\n  "version": "1.2.2"\n}\n');
  commit(seed, 'a.txt', 'one\n', 'base');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'stage');
  // The closed release: stage at the time plus the version bump, then the branch is deleted.
  git(seed, 'checkout', '-b', 'release/1.2.3');
  writeFileSync(join(seed, 'package.json'), '{\n  "name": "fixture",\n  "version": "1.2.3"\n}\n');
  const oldHead = commit(seed, 'package.json', readFileSync(join(seed, 'package.json'), 'utf8'), 'chore: bump version to 1.2.3');
  git(seed, 'push', 'origin', `${oldHead}:refs/pull/4/head`);
  // Work merged to stage after the PR was closed.
  git(seed, 'checkout', 'stage');
  const later = commit(seed, 'b.txt', 'new work\n', 'SF-1: work merged after the release was closed');
  git(seed, 'push', 'origin', 'stage');
  git(root, 'clone', '-b', 'stage', remote, runner);
  git(runner, 'config', 'user.email', 'test@example.invalid'); git(runner, 'config', 'user.name', 'Test');
  const calls = join(root, 'gh-calls'); writeFileSync(calls, '');
  const state = join(root, 'pr-state'); writeFileSync(state, 'closed');
  execFileSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${calls}"
if [ "$3" = PATCH ]; then
  [ "${reopen}" = ok ] || exit 1
  echo open > "${state}"; echo '{}'; exit 0
fi
cat "${state}"
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const output = join(root, 'output'), summary = join(root, 'summary');
  const run = name => {
    const shell = stepOf(name).match(/        run: \|\n([\s\S]*)/)[1].split('\n').map(l => l.slice(10)).join('\n');
    writeFileSync(output, '');
    return spawnSync('bash', ['-e', '-c', shell], {cwd: runner, encoding: 'utf8', env: {...process.env,
      PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'x', GITHUB_REPOSITORY: 'example/app', NEW_VERSION: '1.2.3',
      PR_NUMBER: '4', OLD_HEAD: oldHead, STAGING_BRANCH: 'stage', PACKAGE_FILE: 'package.json', PACKAGE_LOCK: 'package-lock.json',
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary}});
  };
  const remoteHead = () => { try { return git(remote, 'rev-parse', 'refs/heads/release/1.2.3'); } catch { return ''; } };
  const show = (ref, file) => git(remote, 'show', `${ref}:${file}`);
  return {git, commit, seed, runner, remote, oldHead, later, run, remoteHead, show, output, calls, state};
}
const ok = result => assert.equal(result.status, 0, result.stderr + result.stdout);

test('deleted branch: restored, PR reopened, stage merged in, version kept', t => {
  const f = restoreFixture(t);
  ok(f.run('Restore the closed release'));
  const head = f.remoteHead();
  assert.equal(readFileSync(f.state, 'utf8').trim(), 'open');
  assert.equal(f.git(f.remote, 'rev-parse', `${head}^1`), f.oldHead, 'the release keeps the closed PR\'s commits');
  assert.equal(f.git(f.remote, 'rev-parse', `${head}^2`), f.later, 'stage is merged in as a merge commit');
  assert.equal(f.show(head, 'b.txt'), 'new work');
  assert.equal(JSON.parse(f.show(head, 'package.json')).version, '1.2.3');
  assert.match(readFileSync(f.output, 'utf8'), /pr_number=4/);
  // The later Create release branch step reuses this branch and its version check passes.
  ok(f.run('Create release branch'));
  assert.match(readFileSync(f.output, 'utf8'), /reused=true/);
  assert.equal(f.git(f.runner, 'rev-parse', 'HEAD'), head);
});

test('a bump left by an earlier failed run is replaced', t => {
  const f = restoreFixture(t);
  f.git(f.runner, 'checkout', '-q', '-b', 'leftover');
  writeFileSync(join(f.runner, 'package.json'), '{\n  "name": "fixture",\n  "version": "1.2.3"\n}\n');
  const leftover = f.commit(f.runner, 'package.json', readFileSync(join(f.runner, 'package.json'), 'utf8'), 'chore: bump version to 1.2.3');
  f.git(f.runner, 'push', 'origin', 'HEAD:refs/heads/release/1.2.3'); f.git(f.runner, 'checkout', '-q', 'stage');
  ok(f.run('Restore the closed release'));
  const head = f.remoteHead();
  assert.notEqual(head, leftover);
  assert.equal(f.git(f.remote, 'rev-parse', `${head}^1`), f.oldHead);
  assert.equal(readFileSync(f.state, 'utf8').trim(), 'open');
});

test('commits pushed to the branch after closing are kept', t => {
  const f = restoreFixture(t);
  f.git(f.seed, 'checkout', '-q', '--detach', f.oldHead);
  const human = f.commit(f.seed, 'fix.txt', 'late fix\n', 'late release fix');
  f.git(f.seed, 'push', 'origin', 'HEAD:refs/heads/release/1.2.3');
  ok(f.run('Restore the closed release'));
  const head = f.remoteHead();
  assert.equal(f.git(f.remote, 'rev-parse', `${head}^1`), human);
  assert.equal(f.show(head, 'fix.txt'), 'late fix');
  assert.equal(f.show(head, 'b.txt'), 'new work');
});

test('unknown commits on the branch stop the run before anything changes', t => {
  const f = restoreFixture(t);
  f.git(f.seed, 'checkout', '-q', '--detach', 'stage');
  const other = f.commit(f.seed, 'other.txt', 'someone else\n', 'unrelated work');
  f.git(f.seed, 'push', 'origin', 'HEAD:refs/heads/release/1.2.3');
  const result = f.run('Restore the closed release');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /has commits that are not in #4/);
  assert.equal(f.remoteHead(), other);
  assert.equal(readFileSync(f.calls, 'utf8'), '', 'the PR is not touched');
});

test('when GitHub refuses to reopen, commits pushed after closing are put back', t => {
  const f = restoreFixture(t, {reopen: 'fail'});
  f.git(f.seed, 'checkout', '-q', '--detach', f.oldHead);
  const human = f.commit(f.seed, 'fix.txt', 'late fix\n', 'late release fix');
  f.git(f.seed, 'push', 'origin', 'HEAD:refs/heads/release/1.2.3');
  const result = f.run('Restore the closed release');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /would not reopen #4/);
  assert.equal(f.remoteHead(), human);
});

test('a stage conflict leaves the PR open on its old commits and says what to do', t => {
  const f = restoreFixture(t);
  f.git(f.seed, 'checkout', '-q', '--detach', f.oldHead);
  const human = f.commit(f.seed, 'b.txt', 'release side\n', 'release edit');
  f.git(f.seed, 'push', 'origin', 'HEAD:refs/heads/release/1.2.3');
  const result = f.run('Restore the closed release');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /conflicts with release\/1\.2\.3/);
  assert.equal(f.remoteHead(), human);
  assert.equal(readFileSync(f.state, 'utf8').trim(), 'open');
  assert.doesNotMatch(readFileSync(f.output, 'utf8'), /pr_number/);
});

// ---- Create Pull Request after a reopen ----
const START = '<!-- sf-release-notes:start -->', END = '<!-- sf-release-notes:end -->';
async function createAfterReopen({reopened = '7', body}) {
  const notes = `${START}\nfresh notes with SF-2\n${END}\n`;
  const pr = {number: 7, node_id: 'PR_7', state: 'open', draft: false, html_url: 'https://github.com/example/app/pull/7', body,
    head: {ref: 'release/1.2.3', repo: {full_name: 'example/app'}}, base: {ref: 'main', repo: {full_name: 'example/app'}},
    labels: [{name: 'release'}]};
  const updates = [], outputs = {};
  const github = {rest: {pulls: {
    list: async () => ({data: [pr]}),
    get: async () => ({data: structuredClone(pr)}),
    update: async ({body: next}) => { updates.push(next); pr.body = next; },
    create: async () => { throw new Error('must not create'); },
  }, issues: {getLabel: async ({name}) => ({data: {name}}), addLabels: async () => {}}}, graphql: async () => ({})};
  github.paginate = async (method, args) => (await method(args)).data;
  await withEnv({VERSION: '1.2.3', NOTES_FILE: 'n.md', MAIN_BRANCH: 'main', REOPENED_PR: reopened}, () => scriptOf('Create Pull Request')(
    () => ({readFileSync: () => notes}), github, {repo: {owner: 'example', repo: 'app'}}, {setOutput: (k, v) => outputs[k] = v}));
  return {pr, updates, outputs};
}

test('a reopened PR gets fresh notes and keeps everything outside the notes block', async () => {
  const body = `## Release v1.2.3\n\n${START}\nold notes\n${END}\n\n### Checklist\n- [x] Tests pass\n\n[SF-1]: https://jira/SF-1`;
  const {pr, updates, outputs} = await createAfterReopen({body});
  assert.equal(updates.length, 1);
  assert.equal(pr.body, `## Release v1.2.3\n\n${START}\nfresh notes with SF-2\n${END}\n\n### Checklist\n- [x] Tests pass\n\n[SF-1]: https://jira/SF-1`);
  assert.equal(outputs.pr_number, 7);
});

test('a reopened PR with no notes block gets the notes added, nothing removed', async () => {
  const {pr} = await createAfterReopen({body: 'Human text'});
  assert.ok(pr.body.startsWith('Human text\n\n') && pr.body.includes('fresh notes with SF-2'));
});

test('an open PR this run did not reopen keeps its description', async () => {
  const body = `${START}\nreviewed notes\n${END}`;
  const {pr, updates} = await createAfterReopen({reopened: '', body});
  assert.equal(updates.length, 0); assert.equal(pr.body, body);
});
