// The real run: blocks of pr-preview.yml, driven with fake gh/aws, to pin the race handling:
// a late out-of-date build never switches the preview, a PR closed mid-upload keeps no
// preview, and a delayed cleanup never deletes a reopened PR's preview.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/pr-preview.yml', import.meta.url), 'utf8');

function stepScript(name) {
  const start = workflow.indexOf(`      - name: ${name}`);
  assert.ok(start >= 0, `step ${name} exists`);
  const rest = workflow.slice(start).split('\n').slice(1);
  const runAt = rest.findIndex(line => line === '        run: |');
  assert.ok(runAt >= 0, `step ${name} has a run block`);
  const body = [];
  for (const line of rest.slice(runAt + 1)) {
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
mkdirSync(join(dir, 'site', 'assets'), {recursive: true});
writeFileSync(join(dir, 'site', 'index.html'), '<html></html>');
// gh prints the PR's "<state> <head sha>" from a file; aws logs its calls and can change that
// file at a chosen point, to fake the PR moving on or closing while the upload runs.
writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/bash\ncat "${dir}/state"\n`, {mode: 0o755});
writeFileSync(join(dir, 'bin', 'aws'), [
  '#!/bin/bash',
  `echo "aws $*" >> "${dir}/calls"`,
  `if [[ "$*" == *"s3 sync"* && -f "${dir}/after_sync" ]]; then cp "${dir}/after_sync" "${dir}/state"; fi`,
  `if [[ "$*" == *"s3 cp"*index.html* && -f "${dir}/after_index" ]]; then cp "${dir}/after_index" "${dir}/state"; fi`,
  '',
].join('\n'), {mode: 0o755});

function runStep(name, env) {
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['-c', stepScript(name)], {
    encoding: 'utf8',
    env: {...process.env, ...env, PATH: `${dir}/bin:${process.env.PATH}`, GITHUB_OUTPUT: out,
      RUNNER_TEMP: dir, GITHUB_REPOSITORY: 'servefirstcx/sf-admin'},
  });
  assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
  return Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => l.split('=')));
}

function scenario({action, state, afterSync, afterIndex}) {
  for (const f of ['calls', 'after_sync', 'after_index']) if (existsSync(join(dir, f))) unlinkSync(join(dir, f));
  writeFileSync(join(dir, 'state'), state);
  if (afterSync) writeFileSync(join(dir, 'after_sync'), afterSync);
  if (afterIndex) writeFileSync(join(dir, 'after_index'), afterIndex);
  const env = {APP_NAME: 'admin', PREVIEW_ACTION: action, ARTIFACT_NAME: 'site', PR_NUMBER: '7',
    HEAD_SHA: 'aaa', BUCKET: 'bucket', SITE_DIR: join(dir, 'site')};
  const {prefix} = runStep('Validate inputs', env);
  const res = {};
  if (action === 'publish') {
    Object.assign(res, runStep('Check this is still the newest commit of an open PR', env));
    if (res.stale === 'false') Object.assign(res, runStep('Upload preview to S3', {...env, PREFIX: prefix}));
  } else {
    Object.assign(res, runStep('Check the PR is still closed', env));
    if (res.reopened === 'false') runStep('Remove preview from S3', {...env, PREFIX: prefix});
  }
  const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
  res.indexUploaded = /s3 cp .*index\.html/.test(calls);
  res.removed = /s3 rm s3:\/\/bucket\/admin\/pr-7\//.test(calls);
  res.synced = /s3 sync/.test(calls);
  res.usedDelete = /--delete/.test(calls);
  return res;
}

test('the newest commit of an open PR is published, additively', () => {
  const r = scenario({action: 'publish', state: 'open aaa'});
  assert.equal(r.switched, 'true');
  assert.ok(r.indexUploaded && r.synced && !r.removed && !r.usedDelete);
});

test('a late build of an older commit uploads nothing', () => {
  const r = scenario({action: 'publish', state: 'open bbb'});
  assert.equal(r.stale, 'true');
  assert.ok(!r.synced && !r.indexUploaded);
});

test('a build for a closed PR uploads nothing', () => {
  const r = scenario({action: 'publish', state: 'closed aaa'});
  assert.equal(r.stale, 'true');
  assert.ok(!r.synced && !r.indexUploaded);
});

test('a newer push during the upload stops the switch to this build', () => {
  const r = scenario({action: 'publish', state: 'open aaa', afterSync: 'open bbb'});
  assert.equal(r.switched, 'false');
  assert.ok(!r.indexUploaded && !r.removed);
});

test('a PR closed during the upload keeps no preview (before or after index.html)', () => {
  for (const timing of [{afterSync: 'closed aaa'}, {afterIndex: 'closed aaa'}]) {
    const r = scenario({action: 'publish', state: 'open aaa', ...timing});
    assert.equal(r.switched, 'false');
    assert.ok(r.removed, JSON.stringify(timing));
  }
});

test('cleanup deletes the preview of a closed PR', () => {
  const r = scenario({action: 'cleanup', state: 'closed aaa'});
  assert.equal(r.reopened, 'false');
  assert.ok(r.removed);
});

test('a delayed cleanup never deletes the preview of a reopened PR', () => {
  const r = scenario({action: 'cleanup', state: 'open bbb'});
  assert.equal(r.reopened, 'true');
  assert.ok(!r.removed);
});

test('the job only runs for same-repository pull_request events and has no concurrency group', () => {
  assert.match(workflow, /github\.event_name == 'pull_request' &&/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.doesNotMatch(workflow, /^\s+concurrency:/m);
});
