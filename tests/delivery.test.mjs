import test from 'node:test';
import assert from 'node:assert/strict';
import * as d from '../scripts/delivery.mjs';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), MERGE = 'c'.repeat(40);
const notes = (text = 'Useful summary.\n\n- [#12](https://github.com/org/repo/pull/12) Fix things', head = HEAD) => `<!-- sf-release-notes:start -->\n<!-- sf-release-source:${JSON.stringify({base: BASE, head})} -->\n${text}\n<!-- sf-release-notes:end -->`;

test('generated Markdown punctuation and entities render as plain Slack text', () => {
  assert.equal(d.markdownToSlack('Fix API \\- reply\\_to &amp; sender'), 'Fix API - reply_to &amp; sender');
  assert.equal(d.markdownToSlack('## Included changes'), '*Included changes*');
  assert.equal(d.markdownToSlack('&lt;!channel&gt;'), '&lt;!channel&gt;');
});

test('strict notes parser preserves human Markdown with provenance', () => {
  assert.equal(typeof d.parseNotes, 'function');
  const parsed = d.parseNotes(`PR intro\n${notes()}\nOther content`);
  assert.equal(parsed.head, HEAD);
  assert.equal(parsed.base, BASE);
  assert.match(parsed.content, /Useful summary/);
  assert.equal(parsed.block, notes());
});

const pr = (body = notes()) => ({number: 7, title: 'Release 1.2', body, merged: true, merge_commit_sha: MERGE, head: {sha: HEAD}, base: {ref: 'main', sha: MERGE}, labels: [{name: 'release'}], html_url: 'https://github.com/org/repo/pull/7'});
function apiFixture(overrides = {}) {
  const calls = [];
  let release;
  const routes = {
    'GET /git/ref/tags/v1.2': {object: {type: 'commit', sha: MERGE}},
    'GET /pulls/7': pr(),
    [`GET /commits/${MERGE}`]: {sha: MERGE, parents: [{sha: BASE}, {sha: HEAD}]},
    [`GET /compare/${BASE}...${BASE}`]: {status: 'identical'},
    [`GET /compare/${BASE}...${MERGE}`]: {status: 'ahead'},
    'GET /releases/tags/v1.2': () => release || [404, {}],
    'POST /releases': body => (release = {...body, id: 9, html_url: 'https://github.com/org/repo/releases/tag/v1.2'}),
    'GET /releases/9': () => release,
    ...overrides,
  };
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/repos/org/repo', '') + new URL(url).search;
    const key = `${init.method || 'GET'} ${path}`;
    const body = init.body && JSON.parse(init.body);
    calls.push({key, body, init});
    assert.ok(key in routes, `Unexpected request ${key}`);
    const value = typeof routes[key] === 'function' ? routes[key](body) : routes[key];
    const [status, data] = Array.isArray(value) ? value : [200, value];
    return new Response(JSON.stringify(data), {status});
  };
  return {fetch, calls};
}
const publishOptions = {repository: 'org/repo', token: 'secret', version: '1.2', event: {action: 'closed', pull_request: pr()}};
const deployOptions = {repository: 'org/repo', token: 'secret', version: '1.2', deployedSha: MERGE, environment: 'production', status: 'success', runUrl: 'https://github.com/org/repo/actions/runs/123'};

test('webhook delivery is optional, HTTPS allowlisted, nonredirecting, timed and never leaks errors', async () => {
  assert.equal(typeof d.sendSlack, 'function');
  assert.deepEqual(await d.sendSlack({payload: {text: 'test'}, fetch: () => assert.fail('No webhook')}), {sent: false, skipped: true});
  const webhook = 'https://hooks.slack.com/services/T123/B456/secret';
  for (const bad of ['http://hooks.slack.com/services/T/B/S', 'https://hooks.slack.com.evil.test/services/T/B/S', 'https://user:pass@hooks.slack.com/services/T/B/S', webhook + '?secret']) {
    await assert.rejects(d.sendSlack({webhook: bad, payload: {}, fetch: () => assert.fail('Bad webhook fetched')}), /Invalid Slack webhook/);
  }
  let posted;
  await d.sendSlack({webhook, payload: {text: 'safe', blocks: [], unfurl_links: false, unfurl_media: false}, fetch: async (url, init) => { posted = {url, init}; return new Response('ok'); }});
  assert.equal(posted.init.redirect, 'error');
  assert.ok(posted.init.signal);
  assert.equal(posted.init.method, 'POST');
  for (const fetch of [async () => new Response('secret response body', {status: 403}), async () => { throw new Error(webhook); }]) {
    await assert.rejects(d.sendSlack({webhook, payload: {}, fetch}), error => !/secret|hooks.slack/.test(error.message));
  }
});

test('notification CLI dry-run writes payload without posting; missing optional webhook skips', async () => {
  const {main} = await import('../scripts/notify-deployment.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  try {
    const file = join(directory, 'payload.json');
    const env = {GITHUB_REPOSITORY: 'org/repo', DEPLOYED_SHA: MERGE, ENVIRONMENT: 'staging', DEPLOY_STATUS: 'success', RUN_URL: deployOptions.runUrl, DRY_RUN: 'true', PAYLOAD_FILE: file};
    const result = await main(env, {fetch: () => assert.fail('No POST'), log: () => {}, warn: () => {}});
    assert.equal(result.sent, false);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).unfurl_links, false);
    assert.equal((await main({}, {fetch: () => assert.fail('No fetch'), log: () => {}})).skipped, true);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('publication CLI emits verified release_url and refuses output newline injection', async () => {
  const {main} = await import('../scripts/publish-release.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'release-test-'));
  try {
    const eventFile = join(directory, 'event.json'), output = join(directory, 'output');
    await writeFile(eventFile, JSON.stringify(publishOptions.event));
    const fixture = apiFixture();
    await main({GH_TOKEN: 'secret', GITHUB_REPOSITORY: 'org/repo', GITHUB_EVENT_PATH: eventFile, VERSION: '1.2', GITHUB_OUTPUT: output}, {fetch: fixture.fetch, log: () => {}, warn: () => {}});
    assert.equal(await readFile(output, 'utf8'), 'release_url=https://github.com/org/repo/releases/tag/v1.2\n');
    assert.throws(() => d.outputLine('release_url', 'url\nINJECT=yes'), /single-line/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('Slack renders safe Markdown links without raw mention, HTML or code injection', () => {
  const payload = d.buildSlackPayload({...deployOptions, repository: 'repo\n<!channel>', version: 'v1\n```', content: 'Hello <@U123> & <!channel> @here ```\n- [SF-1](https://tickets.example/SF-1?a=1&b=2) [click|<!here>](javascript:alert)\n[bad](https://example.test/|<!channel>)', notesUrl: 'https://github.com/org/repo/releases/tag/v1.2'});
  const text = payload.blocks.filter(b => b.type === 'section').map(b => b.text.text).join('\n');
  assert.match(text, /<https:\/\/tickets.example\/SF-1\?a=1&amp;b=2\|SF-1>/);
  assert.doesNotMatch(text, /<@|<!|```|@here|<javascript:/);
  assert.match(text, /&lt;@U123&gt;/);
  assert.ok(payload.blocks[0].text.text.length <= 150);
  assert.doesNotMatch(payload.blocks[0].text.text, /\n|`|<!/);
});

test('Slack keeps ordinary lists complete and truncates oversized notes explicitly with full-notes link', () => {
  const line = i => `- [PR #${i}](https://github.com/org/repo/pull/${i}) Description for ticket SF-${i}`;
  for (const count of [30, 1200]) {
    const payload = d.buildSlackPayload({...deployOptions, content: Array.from({length: count}, (_, i) => line(i + 1)).join('\n'), notesUrl: 'https://github.com/org/repo/releases/tag/v1.2'});
    const text = payload.blocks.map(b => b.text.text).join('\n');
    assert.ok(payload.blocks.length <= 50);
    assert.ok(payload.blocks.every(b => b.text.text.length <= (b.type === 'header' ? 150 : 3000)));
    assert.ok(text.length < 40000);
    assert.ok(payload.text.length <= 4000);
    if (count === 30) { assert.match(text, /SF-30/); assert.doesNotMatch(text, /truncated/); }
    else { assert.match(text, /truncated/); assert.match(text, /Full release notes/); }
  }
});

test('production notes use exact deployed tag and associated PR, including pagination and release creation race', async () => {
  for (const releaseMissing of [false, true]) {
    const fixture = apiFixture({
      [`GET /commits/${MERGE}/pulls?per_page=100&page=1`]: [200, Array.from({length: 100}, (_, i) => ({number: i + 100, merge_commit_sha: HEAD}))],
      [`GET /commits/${MERGE}/pulls?per_page=100&page=2`]: [200, [pr()]],
      'GET /releases/tags/v1.2': releaseMissing ? [404, {}] : {tag_name: 'v1.2', draft: false, prerelease: false, body: notes('Edited published summary.')},
    });
    assert.equal(typeof d.prepareDeployment, 'function');
    const result = await d.prepareDeployment({...deployOptions, fetch: fixture.fetch});
    const text = JSON.stringify(result.payload);
    assert.match(text, releaseMissing ? /Useful summary/ : /Edited published summary/);
    assert.equal(result.payload.unfurl_links, false);
    assert.equal(result.payload.unfurl_media, false);
    assert.doesNotMatch(text, /sf-release-source|Deployer|Branch|Commit/);
    assert.equal(result.notesAvailable, true);
  }
});

test('failed, staging and unversioned deploys never retrieve release notes', async () => {
  for (const overrides of [{status: 'failure'}, {status: 'cancelled'}, {status: 'skipped'}, {environment: 'staging'}, {environment: 'dev'}, {version: ''}]) {
    const result = await d.prepareDeployment({...deployOptions, ...overrides, fetch: () => assert.fail('Must not fetch')});
    assert.equal(result.notesAvailable, false);
    assert.doesNotMatch(JSON.stringify(result.payload), /Useful summary|released|shipped/);
    assert.match(JSON.stringify(result.payload), /actions\/runs\/123/);
  }
});

test('failed checkout still notifies failure or cancellation without a deployed SHA', async () => {
  for (const status of ['failure', 'cancelled', 'skipped']) {
    const result = await d.prepareDeployment({...deployOptions, status, deployedSha: '', version: '', fetch: () => assert.fail('No provenance lookup on failure')});
    assert.match(JSON.stringify(result.payload), new RegExp(status));
    assert.equal(result.notesAvailable, false);
  }
});

test('mismatch, stale release provenance or ambiguous associations never emit untrusted notes', async () => {
  const associations = {[`GET /commits/${MERGE}/pulls?per_page=100&page=1`]: [200, [pr()]]};
  for (const overrides of [
    {'GET /git/ref/tags/v1.2': {object: {type: 'commit', sha: HEAD}}},
    {...associations, 'GET /releases/tags/v1.2': {tag_name: 'v1.2', draft: false, prerelease: false, body: notes('WRONG SUMMARY', BASE)}},
    {[`GET /commits/${MERGE}/pulls?per_page=100&page=1`]: [200, []]},
  ]) {
    const fixture = apiFixture(overrides);
    const result = await d.prepareDeployment({...deployOptions, fetch: fixture.fetch});
    assert.equal(result.notesAvailable, false);
    assert.match(JSON.stringify(result.payload), /unavailable/);
    assert.doesNotMatch(JSON.stringify(result.payload), /WRONG SUMMARY|Useful summary/);
  }
});

test('rerun retains published human edits and handles a concurrent release create', async () => {
  const existing = {id: 9, tag_name: 'v1.2', draft: false, prerelease: false, body: notes('Human-edited summary.'), html_url: 'https://github.com/org/repo/releases/tag/v1.2'};
  for (const race of [false, true]) {
    let gets = 0;
    const fixture = apiFixture({
      'GET /releases/tags/v1.2': () => race && gets++ === 0 ? [404, {}] : existing,
      'GET /releases/9': existing,
      'POST /releases': [422, {message: 'already exists'}],
    });
    assert.equal((await d.publishRelease({...publishOptions, fetch: fixture.fetch})).body, existing.body);
    assert.equal(fixture.calls.filter(c => c.key.startsWith('PATCH')).length, 0);
  }
});

test('legacy or stale notes publish only an honestly labelled linked PR fallback', async () => {
  for (const body of ['Old release PR without generated notes', notes('STALE CLAIM', BASE)]) {
    const fixture = apiFixture({'GET /pulls/7': pr(body)});
    const result = await d.publishRelease({...publishOptions, fetch: fixture.fetch});
    assert.match(result.body, /Summary unavailable/);
    assert.match(result.body, /\[Release 1.2\]\(https:\/\/github.com\/org\/repo\/pull\/7\)/);
    assert.doesNotMatch(result.body, /STALE CLAIM/);
    assert.equal(result.warnings.length, 1);
  }
});

test('tag and current PR mismatches fail before writes; annotated tags peel', async () => {
  for (const overrides of [
    {'GET /git/ref/tags/v1.2': {object: {type: 'commit', sha: HEAD}}},
    {'GET /pulls/7': {...pr(), merge_commit_sha: HEAD}},
  ]) {
    const fixture = apiFixture(overrides);
    await assert.rejects(d.publishRelease({...publishOptions, fetch: fixture.fetch}), /match/);
    assert.ok(fixture.calls.every(c => c.key.startsWith('GET')));
  }
  const fixture = apiFixture({'GET /git/ref/tags/v1.2': {object: {type: 'tag', sha: HEAD}}, [`GET /git/tags/${HEAD}`]: {object: {type: 'commit', sha: MERGE}}});
  await d.publishRelease({...publishOptions, fetch: fixture.fetch});
});

test('parser rejects malformed, duplicated, empty and extra provenance', () => {
  for (const value of [notes() + '\n' + notes(), notes().replace(HEAD, 'xyz'), notes().replace('sf-release-source:', 'sf-release-source:broken'), notes(''), notes().replace('"base":', '"extra":1,"base":'), notes() + '\n<!-- sf-release-notes:wat -->', notes().replace('"base":', `"head":"${BASE}","base":`)]) {
    assert.equal(d.parseNotes(value), null);
  }
});

test('baseline must be an ancestor of premerge main, not simply any merge ancestor', async () => {
  const fixture = apiFixture({[`GET /compare/${BASE}...${BASE}`]: {status: 'diverged'}});
  const result = await d.publishRelease({...publishOptions, fetch: fixture.fetch});
  assert.match(result.body, /Summary unavailable/);
  assert.doesNotMatch(result.body, /Useful summary/);
});

test('publication refuses unverified existing content and detects failed readback', async () => {
  for (const overrides of [
    {'GET /releases/tags/v1.2': {id: 9, tag_name: 'v1.2', draft: false, prerelease: false, body: 'Unmarked human body'}},
    {'GET /releases/9': {id: 9, tag_name: 'v1.2', draft: false, prerelease: false, body: 'Different body'}},
  ]) {
    await assert.rejects(d.publishRelease({...publishOptions, fetch: apiFixture(overrides).fetch}), /unverified|verification/);
  }
});

test('existing draft gets explicit stable publication flags without losing edits', async () => {
  let release = {id: 9, tag_name: 'v1.2', draft: true, prerelease: true, body: notes('Manual draft edits.'), html_url: 'https://github.com/org/repo/releases/tag/v1.2'};
  const fixture = apiFixture({'GET /releases/tags/v1.2': () => release, 'PATCH /releases/9': body => (release = {...release, ...body}), 'GET /releases/9': () => release});
  const result = await d.publishRelease({...publishOptions, fetch: fixture.fetch});
  assert.match(result.body, /Manual draft edits/);
  assert.deepEqual(fixture.calls.find(c => c.key === 'PATCH /releases/9').body, {body: result.body, draft: false, prerelease: false});
});

test('Slack link sections stay bounded even for unusually long URLs', () => {
  const payload = d.buildSlackPayload({...deployOptions, notesUrl: `https://github.com/${'&'.repeat(1800)}`, runUrl: `https://github.com/${'x'.repeat(1800)}`});
  assert.ok(payload.blocks.every(b => b.text.text.length <= 3000));
});

test('invalid deployment input never fetches; GitHub errors do not expose tokens or response bodies', async () => {
  for (const overrides of [{deployedSha: 'short'}, {environment: 'prod'}, {status: 'released'}, {runUrl: 'https://github.com/other/repo/actions/runs/1'}]) {
    await assert.rejects(d.prepareDeployment({...deployOptions, ...overrides, fetch: () => assert.fail('Invalid input fetch')}));
  }
  const api = d.createGitHub({...deployOptions, fetch: async () => new Response('SECRET server response', {status: 401})});
  await assert.rejects(api('/releases'), error => error.message === 'GitHub request failed (HTTP 401)');
});

test('release-associated PR head edits invalidate notes and multiple matching PRs are ambiguous', async () => {
  for (const overrides of [
    {'GET /pulls/7': {...pr(), head: {sha: BASE}}},
    {[`GET /commits/${MERGE}/pulls?per_page=100&page=1`]: [200, [pr(), {...pr(), number: 8}]], 'GET /pulls/8': {...pr(), number: 8}},
  ]) {
    const fixture = apiFixture({[`GET /commits/${MERGE}/pulls?per_page=100&page=1`]: [200, [pr()]], ...overrides});
    const result = await d.prepareDeployment({...deployOptions, fetch: fixture.fetch});
    assert.equal(result.notesAvailable, false);
    assert.doesNotMatch(JSON.stringify(result.payload), /Useful summary/);
  }
});

test('updated PR head with a valid manually edited block is published verbatim', async () => {
  const body = notes('Human-written replacement summary.\n\n- [SF-42](https://tickets.example/SF-42) The actual change');
  const fixture = apiFixture({'GET /pulls/7': pr(`Intro\n${body}\nIgnored checklist`)});
  assert.equal((await d.publishRelease({...publishOptions, fetch: fixture.fetch})).body, body);
});

test('publish creates missing release even when tag already exists and verifies exact body', async () => {
  const fixture = apiFixture();
  assert.equal(typeof d.publishRelease, 'function');
  const result = await d.publishRelease({...publishOptions, fetch: fixture.fetch});
  assert.equal(result.url, 'https://github.com/org/repo/releases/tag/v1.2');
  const write = fixture.calls.find(c => c.key === 'POST /releases');
  assert.equal(write.body.body, notes());
  assert.equal(write.body.draft, false);
  assert.equal(write.body.prerelease, false);
  assert.equal(fixture.calls.at(-1).key, 'GET /releases/9');
  assert.ok(fixture.calls.every(c => c.init.redirect === 'error' && c.init.signal));
});
