// The real "Decide what the preview should be" step of pr-preview.yml, driven with a fake gh,
// plus checks on how the workflow is wired. The preview is correct when runs are late, out of
// order or dropped because (a) one run at a time holds the group and (b) every run makes the
// preview match the PR's LIVE state, publishing the build of the PR's current head whichever
// run built it. These tests pin (b) for each ordering; (a) is pinned by the wiring checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/pr-preview.yml', import.meta.url), 'utf8');
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const CALLER = '.github/workflows/pr-preview.yml';

function stepBlock(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `step ${name} exists`);
  const next = workflow.indexOf('\n      - name: ', start + 10);
  return workflow.slice(start, next < 0 ? undefined : next);
}

function stepScript(name) {
  const lines = stepBlock(name).split('\n');
  const runAt = lines.findIndex(line => line === '        run: |');
  assert.ok(runAt >= 0, `step ${name} has a run block`);
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  const script = body.join('\n');
  assert.ok(!script.includes('${{'), `step ${name} reads inputs from env only`);
  return script;
}

const dir = mkdtempSync(join(tmpdir(), 'pr-preview-'));
test.after(() => rmSync(dir, {recursive: true, force: true}));
mkdirSync(join(dir, 'bin'));
// Fake gh: answers the three API reads the plan step makes from a JSON world file.
writeFileSync(join(dir, 'bin', 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const w = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'world.json'))}, 'utf8'));
const path = process.argv[3];
if (/\\/pulls\\/\\d+$/.test(path)) { console.log(w.state + ' ' + w.head); process.exit(0); }
let m = path.match(/actions\\/runs\\?head_sha=([0-9a-f]+)/);
if (m) {
  const runs = w.runs.filter(r => r.sha === m[1]).sort((x, y) => y.created.localeCompare(x.created));
  for (const r of runs) if (r.path === ${JSON.stringify(CALLER)}) console.log(r.id);
  process.exit(0);
}
m = path.match(/actions\\/runs\\/(\\d+)\\/artifacts/);
if (m) { const r = w.runs.find(x => String(x.id) === m[1]); console.log(r && r.artifact ? 1 : 0); process.exit(0); }
process.exit(3);
`, {mode: 0o755});

function plan({action, runSha, state, head, runs = []}) {
  writeFileSync(join(dir, 'world.json'), JSON.stringify({state, head, runs}));
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['-c', stepScript('Decide what the preview should be')], {
    encoding: 'utf8',
    env: {...process.env, PATH: `${dir}/bin:${process.env.PATH}`, GITHUB_OUTPUT: out,
      GITHUB_REPOSITORY: 'servefirstcx/sf-admin', GITHUB_RUN_ID: '100', PR_NUMBER: '7',
      PREVIEW_ACTION: action, RUN_SHA: runSha, ARTIFACT_NAME: 'preview-site',
      CALLER_WORKFLOW_REF: `servefirstcx/sf-admin/${CALLER}@refs/pull/7/merge`},
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => l.split('=')));
}

const built = (id, sha, extra = {}) => ({id, sha, path: CALLER, artifact: true, created: `2026-11-05T10:0${id % 10}:00Z`, ...extra});

test('the run for the PR head publishes its own build', () => {
  const p = plan({action: 'publish', runSha: HEAD_A, state: 'open', head: HEAD_A});
  assert.deepEqual(p, {target_sha: HEAD_A, mode: 'publish', source_run: '100'});
});

test('a late run for an older commit publishes the newer head instead, never its own build', () => {
  const p = plan({action: 'publish', runSha: HEAD_A, state: 'open', head: HEAD_B, runs: [built(101, HEAD_B)]});
  assert.equal(p.mode, 'publish');
  assert.equal(p.source_run, '101');
  assert.equal(p.target_sha, HEAD_B);
});

test('a late run whose newer head is not built yet changes nothing (that build publishes later)', () => {
  const p = plan({action: 'publish', runSha: HEAD_A, state: 'open', head: HEAD_B,
    runs: [built(101, HEAD_B, {artifact: false})]});
  assert.equal(p.mode, 'wait');
});

test('a closed PR is removed whichever run gets there, publish or cleanup', () => {
  for (const action of ['publish', 'cleanup']) {
    assert.equal(plan({action, runSha: HEAD_A, state: 'closed', head: HEAD_A}).mode, 'remove');
  }
});

test('a cleanup that runs after a reopen restores the preview instead of deleting it', () => {
  const p = plan({action: 'cleanup', runSha: HEAD_A, state: 'open', head: HEAD_B, runs: [built(102, HEAD_B)]});
  assert.equal(p.mode, 'publish');
  assert.equal(p.source_run, '102');
});

test('a cleanup after a reopen whose build is not ready leaves the preview alone', () => {
  assert.equal(plan({action: 'cleanup', runSha: HEAD_A, state: 'open', head: HEAD_A}).mode, 'wait');
});

test('builds from other workflows or with expired artifacts are never used', () => {
  const p = plan({action: 'publish', runSha: HEAD_A, state: 'open', head: HEAD_B,
    runs: [built(103, HEAD_B, {path: '.github/workflows/other.yml'}), built(104, HEAD_B, {artifact: false})]});
  assert.equal(p.mode, 'wait');
});

test('the newest run for the head is preferred when it was built more than once', () => {
  const p = plan({action: 'publish', runSha: HEAD_A, state: 'open', head: HEAD_B,
    runs: [built(105, HEAD_B, {created: '2026-11-05T10:00:00Z'}), built(106, HEAD_B, {created: '2026-11-05T11:00:00Z'})]});
  assert.equal(p.source_run, '106');
});

test('one run at a time per PR and app, never cancelled; pull_request events only', () => {
  assert.match(workflow, /concurrency:\n {6}group: pr-preview-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ inputs\.app_name \}\}\n {6}cancel-in-progress: false\n/);
  assert.match(workflow, /github\.event_name == 'pull_request' &&/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /\n {2}actions: read\n/);
});

test('every write and the comment follow the plan only', () => {
  for (const name of ['Upload preview to S3', 'Download build artifact']) {
    assert.match(stepBlock(name), /if: \$\{\{ steps\.plan\.outputs\.mode == 'publish' \}\}/);
  }
  assert.match(stepBlock('Remove preview from S3'), /if: \$\{\{ steps\.plan\.outputs\.mode == 'remove' \}\}/);
  assert.match(stepBlock('Update sticky PR comment'),
    /if: \$\{\{ steps\.plan\.outputs\.mode == 'publish' \|\| steps\.plan\.outputs\.mode == 'remove' \}\}/);
  assert.match(stepBlock('Download build artifact'), /run-id: \$\{\{ steps\.plan\.outputs\.source_run \}\}/);
});
