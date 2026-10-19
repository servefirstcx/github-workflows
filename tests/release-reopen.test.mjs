import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
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

// ---- Restore the closed release (real git) ----
const pkg = v => `{\n  "name": "fixture",\n  "version": "${v}"\n}\n`;
const lock = (v, dep = '1.0.0') => `{\n  "name": "fixture",\n  "version": "${v}",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "fixture",\n      "version": "${v}"\n    },\n    "node_modules/dep": {\n      "version": "${dep}"\n    }\n  }\n}\n`;
function restoreFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'release-reopen-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const remote = join(root, 'remote.git'), seed = join(root, 'seed'), runner = join(root, 'runner');
  const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const commit = (cwd, files, message) => {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(cwd, file), text);
    git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); return git(cwd, 'rev-parse', 'HEAD');
  };
  git(root, 'init', '--bare', remote); git(root, 'init', '-b', 'stage', seed);
  git(seed, 'config', 'user.email', 'test@example.invalid'); git(seed, 'config', 'user.name', 'Test');
  commit(seed, {'package.json': pkg('1.2.2'), 'package-lock.json': lock('1.2.2'), 'a.txt': 'one\n'}, 'base');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'stage');
  // The closed release: stage at the time plus the version bump. Its branch is then deleted.
  git(seed, 'checkout', '-q', '-b', 'old-release');
  const oldHead = commit(seed, {'package.json': pkg('1.2.3'), 'package-lock.json': lock('1.2.3')}, 'chore: bump version to 1.2.3');
  git(seed, 'push', 'origin', `${oldHead}:refs/pull/4/head`);
  git(seed, 'checkout', '-q', 'stage');
  const later = commit(seed, {'b.txt': 'new work\n'}, 'SF-1: work merged after the release was closed');
  git(seed, 'push', 'origin', 'stage');
  git(root, 'clone', '-q', '-b', 'stage', remote, runner);
  git(runner, 'config', 'user.email', 'test@example.invalid'); git(runner, 'config', 'user.name', 'Test');
  const output = join(root, 'output');
  const run = name => {
    const shell = stepOf(name).match(/        run: \|\n([\s\S]*)/)[1].split('\n').map(l => l.slice(10)).join('\n');
    writeFileSync(output, '');
    git(runner, 'checkout', '-q', '--detach', 'origin/stage');
    return spawnSync('bash', ['-e', '-c', shell], {cwd: runner, encoding: 'utf8', env: {...process.env,
      NEW_VERSION: '1.2.3', PR_NUMBER: '4', OLD_HEAD: oldHead, STAGING_BRANCH: 'stage',
      PACKAGE_FILE: 'package.json', PACKAGE_LOCK: 'package-lock.json', GITHUB_OUTPUT: output}});
  };
  const remoteHead = () => { try { return git(remote, 'rev-parse', 'refs/heads/release/1.2.3'); } catch { return ''; } };
  const show = (ref, file) => git(remote, 'show', `${ref}:${file}`);
  // Push a commit made on top of `from` to the release branch, as a person (or a failed run) would.
  const pushOnto = (from, files, message, force = false) => {
    git(seed, 'checkout', '-q', '--detach', from);
    const sha = commit(seed, files, message);
    git(seed, 'push', ...(force ? ['-f'] : []), 'origin', 'HEAD:refs/heads/release/1.2.3');
    return sha;
  };
  return {git, seed, runner, remote, oldHead, later, run, remoteHead, show, output, pushOnto};
}
const ok = result => assert.equal(result.status, 0, result.stderr + result.stdout);
const refused = (f, result, pattern, before) => {
  assert.notEqual(result.status, 0, 'the step must fail');
  assert.match(result.stdout + result.stderr, pattern);
  assert.equal(f.remoteHead(), before, 'the release branch is unchanged');
  assert.doesNotMatch(readFileSync(f.output, 'utf8'), /pr_number/, 'nothing is reopened');
};

test('deleted branch: restored on the old commit, stage merged in, version kept', t => {
  const f = restoreFixture(t);
  ok(f.run('Restore the closed release'));
  const head = f.remoteHead();
  assert.equal(f.git(f.remote, 'rev-parse', `${head}^1`), f.oldHead, 'the release continues from the closed PR');
  assert.equal(f.git(f.remote, 'rev-parse', `${head}^2`), f.later, 'stage is merged in as a merge commit');
  assert.equal(f.show(head, 'b.txt'), 'new work');
  assert.equal(JSON.parse(f.show(head, 'package.json')).version, '1.2.3');
  assert.match(readFileSync(f.output, 'utf8'), /pr_number=4/);
  ok(f.run('Create release branch')); // the next step reuses the branch and its version check passes
  assert.match(readFileSync(f.output, 'utf8'), /reused=true/);
  assert.equal(f.git(f.runner, 'rev-parse', 'HEAD'), head);
});

test('a rerun after success changes nothing', t => {
  const f = restoreFixture(t);
  ok(f.run('Restore the closed release')); const head = f.remoteHead();
  ok(f.run('Restore the closed release'));
  assert.equal(f.remoteHead(), head);
  assert.match(readFileSync(f.output, 'utf8'), /pr_number=4/);
});

test('the exact version bump an earlier failed run left is replaced', t => {
  const f = restoreFixture(t);
  const leftover = f.pushOnto('stage', {'package.json': pkg('1.2.3'), 'package-lock.json': lock('1.2.3')}, 'chore: bump version to 1.2.3');
  ok(f.run('Restore the closed release'));
  const head = f.remoteHead();
  assert.notEqual(head, leftover);
  assert.equal(f.git(f.remote, 'rev-parse', `${head}^1`), f.oldHead);
});

for (const [name, files] of [
  ['a dependency added in package.json', {'package.json': pkg('1.2.3').replace('\n}', ',\n  "dependencies": {"x": "2.0.1"}\n}'), 'package-lock.json': lock('1.2.3')}],
  ['a dependency version changed in the lock file', {'package.json': pkg('1.2.3'), 'package-lock.json': lock('1.2.3', '9.9.9')}],
  ['another file changed', {'package.json': pkg('1.2.3'), 'package-lock.json': lock('1.2.3'), 'c.txt': 'extra\n'}],
  ['an existing file edited', {'package.json': pkg('1.2.3'), 'package-lock.json': lock('1.2.3'), 'a.txt': 'edited\n'}],
]) {
  test(`a bump commit that also has ${name} is not thrown away`, t => {
    const f = restoreFixture(t);
    const amended = f.pushOnto('stage', files, 'chore: bump version to 1.2.3');
    refused(f, f.run('Restore the closed release'), /has commits that are not in #4/, amended);
  });
}

test('commits pushed to the branch after closing are kept, without a force push', t => {
  const f = restoreFixture(t);
  const human = f.pushOnto(f.oldHead, {'fix.txt': 'late fix\n'}, 'late release fix');
  ok(f.run('Restore the closed release'));
  const head = f.remoteHead();
  assert.equal(f.git(f.remote, 'rev-parse', `${head}^1`), human);
  assert.equal(f.show(head, 'fix.txt'), 'late fix');
  assert.equal(f.show(head, 'b.txt'), 'new work');
});

test('unknown commits on the branch stop the run before anything changes', t => {
  const f = restoreFixture(t);
  const other = f.pushOnto('stage', {'other.txt': 'someone else\n'}, 'unrelated work');
  refused(f, f.run('Restore the closed release'), /has commits that are not in #4/, other);
});

test('a stage conflict changes nothing, and a rerun after merging by hand completes', t => {
  const f = restoreFixture(t);
  const human = f.pushOnto(f.oldHead, {'b.txt': 'release side\n'}, 'release edit');
  refused(f, f.run('Restore the closed release'), /conflicts with release\/1\.2\.3. #4 is still closed/, human);
  // A lead merges stage in by hand as a merge commit, then runs the workflow again.
  f.git(f.seed, 'checkout', '-q', '--detach', human);
  spawnSync('git', ['merge', '--no-ff', '--no-edit', 'stage'], {cwd: f.seed});
  writeFileSync(join(f.seed, 'b.txt'), 'resolved\n'); f.git(f.seed, 'add', '.'); f.git(f.seed, 'commit', '--no-edit');
  f.git(f.seed, 'push', 'origin', 'HEAD:refs/heads/release/1.2.3');
  const resolved = f.remoteHead();
  ok(f.run('Restore the closed release'));
  assert.equal(f.remoteHead(), resolved);
  assert.match(readFileSync(f.output, 'utf8'), /pr_number=4/);
});

// ---- Create Pull Request: refresh notes, then reopen last ----
const START = '<!-- sf-release-notes:start -->', END = '<!-- sf-release-notes:end -->';
function createFixture({state = 'closed', body, refuseReopen = false}) {
  const notes = `${START}\nfresh notes with SF-2\n${END}\n`;
  const pr = {number: 7, node_id: 'PR_7', state, merged_at: null, draft: false, html_url: 'https://github.com/example/app/pull/7', body,
    head: {ref: 'release/1.2.3', repo: {full_name: 'example/app'}}, base: {ref: 'main', repo: {full_name: 'example/app'}},
    labels: [{name: 'release'}]};
  const calls = [], outputs = {};
  const github = {rest: {pulls: {
    list: async () => ({data: [structuredClone(pr)]}),
    get: async () => ({data: structuredClone(pr)}),
    update: async change => {
      calls.push(Object.keys(change).filter(k => k === 'body' || k === 'state').join());
      if (change.state === 'open' && refuseReopen) throw Object.assign(new Error('state cannot be changed'), {status: 422});
      Object.assign(pr, change.body === undefined ? {} : {body: change.body}, change.state ? {state: change.state} : {});
    },
    create: async () => { throw new Error('must not create'); },
  }, issues: {getLabel: async ({name}) => ({data: {name}}), addLabels: async () => {}}}, graphql: async () => ({})};
  github.paginate = async (method, args) => (await method(args)).data;
  const invoke = reopen => withEnv({VERSION: '1.2.3', NOTES_FILE: 'n.md', MAIN_BRANCH: 'main', REOPEN_PR: reopen}, () =>
    scriptOf('Create Pull Request')(() => ({readFileSync: () => notes}), github, {repo: {owner: 'example', repo: 'app'}},
      {setOutput: (k, v) => outputs[k] = v, info: () => {}}));
  return {pr, calls, outputs, invoke};
}

test('a restored PR gets fresh notes while closed, then is reopened last', async () => {
  const body = `## Release v1.2.3\n\n${START}\nold notes\n${END}\n\n### Checklist\n- [x] Tests pass\n\n[SF-1]: https://jira/SF-1`;
  const f = createFixture({body});
  await f.invoke('7');
  assert.deepEqual(f.calls, ['body', 'state'], 'notes first, reopen last');
  assert.equal(f.pr.state, 'open');
  assert.equal(f.pr.body, `## Release v1.2.3\n\n${START}\nfresh notes with SF-2\n${END}\n\n### Checklist\n- [x] Tests pass\n\n[SF-1]: https://jira/SF-1`);
  assert.equal(f.outputs.pr_number, 7);
});

test('a restored PR with no notes block gets the notes added, nothing removed', async () => {
  const f = createFixture({body: 'Human text'});
  await f.invoke('7');
  assert.ok(f.pr.body.startsWith('Human text\n\n') && f.pr.body.includes('fresh notes with SF-2'));
});

test('if GitHub refuses to reopen, the PR stays closed and a rerun can finish', async () => {
  const f = createFixture({body: `${START}\nold\n${END}`, refuseReopen: true});
  await assert.rejects(f.invoke('7'), /GitHub would not reopen #7.*Reopen it by hand/);
  assert.equal(f.pr.state, 'closed'); assert.deepEqual(f.outputs, {});
  const g = createFixture({body: f.pr.body});
  await g.invoke('7');
  assert.equal(g.pr.state, 'open'); assert.ok(g.pr.body.includes('fresh notes with SF-2'));
});

for (const [name, change] of [['already open', {state: 'open'}], ['merged', {merged_at: '2026-10-19T00:00:00Z'}]]) {
  test(`a PR that is ${name} by the time of reopening is left alone`, async () => {
    const f = createFixture({body: `${START}\nreviewed\n${END}`});
    Object.assign(f.pr, change);
    await assert.rejects(f.invoke('7'), /Release PR to reopen changed/);
    assert.deepEqual(f.calls, []);
  });
}

test('an open PR keeps its description when nothing was restored', async () => {
  const body = `${START}\nreviewed notes\n${END}`;
  const f = createFixture({state: 'open', body});
  await f.invoke('');
  assert.deepEqual(f.calls, []); assert.equal(f.pr.body, body);
});

test('a closed PR that was not restored still fails as before', async () => {
  const f = createFixture({body: 'x'});
  await assert.rejects(f.invoke(''), /Ambiguous or closed release PR/);
  assert.deepEqual(f.calls, []);
});
