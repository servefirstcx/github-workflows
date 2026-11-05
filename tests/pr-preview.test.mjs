// The real "Reconcile the preview with the PR" step of pr-preview.yml, run with a fake gh and
// aws, plus checks on how the job is wired. Correctness rests on (a) one run at a time per PR
// and app (pinned by the wiring checks) and (b) each run making the preview match the PR's
// live state, re-reading until two reads agree with what it did (pinned by the scenarios).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/pr-preview.yml', import.meta.url), 'utf8');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

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
const world = join(dir, 'world.json');
const log = join(dir, 'log.txt');

// Fake gh. world.json: {reads: ["open <sha>", ...] (one per PR read, the last repeats),
// builds: {<sha>: [run ids newest first with a live artifact]}, comment: id or null}.
writeFileSync(join(dir, 'bin', 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const w = JSON.parse(fs.readFileSync(${JSON.stringify(world)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(world)}, JSON.stringify(w));
const log = s => fs.appendFileSync(${JSON.stringify(log)}, s + '\\n');
const a = process.argv.slice(2);
if (a[0] === 'run' && a[1] === 'download') {
  // Like real gh in a job with no checkout: without --repo there is no repository to use.
  if (a[a.indexOf('--repo') + 1] !== 'servefirstcx/sf-admin' || !a.includes('--repo')) { console.error('not a git repository'); process.exit(1); }
  const d = a[a.indexOf('-D') + 1];
  fs.mkdirSync(d + '/assets', {recursive: true});
  fs.writeFileSync(d + '/index.html', 'built by ' + a[2]);
  log('download ' + a[2]);
  process.exit(0);
}
const path = a.find(x => x.startsWith('repos/'));
if (a.includes('PATCH') || a.includes('POST')) {
  const body = a[a.indexOf('-f') + 1];
  log((a.includes('PATCH') ? 'patch ' : 'post ') + (/Commit:\\*\\* .([0-9a-f]{7})/.exec(body)?.[1] || (body.includes('removed') ? 'removed' : '?')));
  if (a.includes('POST')) { w.comment = 99; save(); }
  process.exit(0);
}
if (/\\/pulls\\/\\d+$/.test(path)) {
  const r = w.reads.length > 1 ? w.reads.shift() : w.reads[0];
  save(); log('read ' + r.slice(0, 13));
  if (r === 'ERR') process.exit(1);
  console.log(r); process.exit(0);
}
let m = path.match(/workflows\\/([^/]+)\\/runs\\?head_sha=([0-9a-f]+)/);
if (m) { if (w.runsErr || m[1] !== 'pr-preview.yml') process.exit(4); for (const id of (w.builds[m[2]] || [])) console.log(id); process.exit(0); }
if (/\\/runs\\/\\d+\\/artifacts/.test(path)) { if (w.artifactsErr) process.exit(5); console.log(1); process.exit(0); }
if (/\\/issues\\/\\d+\\/comments$/.test(path)) { if (w.comment) console.log(w.comment); process.exit(0); }
process.exit(3);
`, {mode: 0o755});
writeFileSync(join(dir, 'bin', 'aws'), `#!/bin/bash
echo "aws $*" | sed -E 's/--cache-control [^ ]+ ?//' >> ${JSON.stringify(log)}
[[ "$*" == *create-invalidation* ]] && echo I1
exit 0
`, {mode: 0o755});
writeFileSync(join(dir, 'bin', 'sleep'), '#!/bin/bash\nexit 0\n', {mode: 0o755});

function reconcile({action = 'publish', runSha = A, reads, builds = {}, comment = 7, runsErr = false, artifactsErr = false}) {
  writeFileSync(world, JSON.stringify({reads, builds, comment, runsErr, artifactsErr}));
  writeFileSync(log, '');
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['-c', stepScript('Reconcile the preview with the PR')], {
    encoding: 'utf8', cwd: dir,
    env: {...process.env, PATH: `${dir}/bin:${process.env.PATH}`, GITHUB_OUTPUT: out,
      GITHUB_REPOSITORY: 'servefirstcx/sf-admin', GITHUB_RUN_ID: '100', PR_NUMBER: '7',
      PREVIEW_ACTION: action, RUN_SHA: runSha, ARTIFACT_NAME: 'preview-site', APP_NAME: 'admin',
      CALLER_WORKFLOW_REF: 'servefirstcx/sf-admin/.github/workflows/pr-preview.yml@refs/pull/7/merge',
      BUCKET: 'bucket', PREFIX: 'admin/pr-7', SITE_DIR: 'site', DISTRIBUTION_ID: 'D1',
      MARKER: '<!-- pr-preview:admin -->', PREVIEW_URL: 'https://admin-pr-7.preview.servefirst.co.uk'},
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  const outputs = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => l.split('=')));
  return {status: r.status, stdout: r.stdout + r.stderr, calls, outputs,
    index: calls.filter(c => /s3 cp .*index\.html/.test(c)).length,
    removed: calls.some(c => /s3 rm s3:\/\/bucket\/admin\/pr-7\/ --recursive/.test(c)),
    downloads: calls.filter(c => c.startsWith('download ')),
    comments: calls.filter(c => /^(patch|post) /.test(c))};
}

test('the run for the PR head publishes its own build and comments that commit', () => {
  const r = reconcile({reads: [`open ${A}`], builds: {[A]: [100]}});
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.downloads, ['download 100']);
  assert.equal(r.index, 1);
  assert.deepEqual(r.comments, ['patch aaaaaaa']);
  assert.equal(r.outputs.mode, 'publish');
});

test('a late run for an older commit publishes the newer head instead, never its own build', () => {
  const r = reconcile({runSha: A, reads: [`open ${B}`], builds: {[A]: [100], [B]: [101]}});
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.downloads, ['download 101']);
  assert.deepEqual(r.comments, ['patch bbbbbbb']);
});

test('a late run whose newer head is not built yet changes nothing', () => {
  const r = reconcile({runSha: A, reads: [`open ${B}`], builds: {[A]: [100]}});
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.outputs.mode, 'wait');
  assert.equal(r.index, 0);
  assert.ok(!r.removed);
  assert.deepEqual(r.comments, []);
});

test('a stale first read is corrected in the same run (the newer build ends up live)', () => {
  // B's own run: the API still says A on the first two reads (before and after the settle
  // pause), then catches up. The run publishes A, re-reads, sees B and publishes B.
  const r = reconcile({runSha: B, reads: [`open ${A}`, `open ${A}`, `open ${B}`], builds: {[A]: [100], [B]: [101]}});
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.downloads, ['download 100', 'download 101']);
  assert.deepEqual(r.comments, ['patch aaaaaaa', 'patch bbbbbbb']);
  assert.equal(r.outputs.target_sha, B);
});

test('a stale read that finds no build is corrected too (no silent lost publish)', () => {
  const r = reconcile({runSha: B, reads: [`open ${A}`, `open ${A}`, `open ${B}`], builds: {[B]: [101]}});
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.downloads, ['download 101']);
  assert.equal(r.outputs.mode, 'publish');
});

test('a closed PR is removed whichever run gets there, and the comment says so', () => {
  for (const action of ['publish', 'cleanup']) {
    const r = reconcile({action, reads: [`closed ${A}`], builds: {[A]: [100]}});
    assert.equal(r.status, 0, r.stdout);
    assert.ok(r.removed);
    assert.equal(r.index, 0);
    assert.deepEqual(r.comments, ['patch removed']);
  }
});

test('a cleanup that runs after a reopen restores the preview instead of deleting it', () => {
  const r = reconcile({action: 'cleanup', reads: [`open ${B}`], builds: {[B]: [102]}});
  assert.equal(r.status, 0, r.stdout);
  assert.ok(!r.removed);
  assert.deepEqual(r.downloads, ['download 102']);
});

test('a PR closed while publishing ends removed in the same run', () => {
  const r = reconcile({reads: [`open ${A}`, `closed ${A}`], builds: {[A]: [100]}});
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.index, 1);
  assert.ok(r.removed);
  assert.deepEqual(r.comments, ['patch aaaaaaa', 'patch removed']);
});

test('removal never posts a new comment when there is none', () => {
  const r = reconcile({action: 'cleanup', reads: [`closed ${A}`], comment: null});
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.comments, []);
});

test('a PR that keeps changing fails the run visibly instead of reporting success', () => {
  const reads = [];
  for (let i = 0; i < 12; i++) reads.push(`open ${i % 2 ? A : B}`);
  const r = reconcile({runSha: B, reads, builds: {[A]: [100], [B]: [101]}});
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /kept changing/);
});

test('an unreadable PR fails the run and never deletes or comments', () => {
  for (const reads of [['ERR'], [`open ${A}`, 'ERR'], ['closedish ' + A], ['open nope']]) {
    const r = reconcile({reads, builds: {[A]: [100]}});
    assert.notEqual(r.status, 0, JSON.stringify(reads));
    assert.ok(!r.removed, JSON.stringify(reads));
    assert.ok(!r.comments.includes('patch removed'), JSON.stringify(reads));
  }
});

test('a failed build lookup fails the run instead of reporting "no build yet"', () => {
  for (const err of [{runsErr: true}, {artifactsErr: true}]) {
    const r = reconcile({reads: [`open ${A}`], builds: {[A]: [100]}, ...err});
    assert.notEqual(r.status, 0, JSON.stringify(err));
    assert.notEqual(r.outputs.mode, 'wait');
    assert.equal(r.index, 0);
  }
});

test('one run at a time per PR and app, never cancelled; pull_request events only', () => {
  assert.match(workflow, /concurrency:\n {6}group: pr-preview-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ inputs\.app_name \}\}\n {6}cancel-in-progress: false\n/);
  assert.match(workflow, /github\.event_name == 'pull_request' &&/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /\n {2}actions: read\n/);
  const outside = workflow.replace(stepBlock('Reconcile the preview with the PR'), '');
  assert.doesNotMatch(outside, /aws s3 |issues\/comments/, 'S3 and comment writes happen only in the reconcile step');
});
