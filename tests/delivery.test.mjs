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

import {closingKeys, branchKeys, shippedTicketKeys} from '../scripts/release-notes.mjs';
const JIRA_HOOK = 'https://api-private.atlassian.com/automation/webhooks/jira/a/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000';
const PREV = 'd'.repeat(40), GAP = '9'.repeat(40), sha = n => String(n).padStart(40, 'e');
const repoPr = (number, ref, extra = {}) => ({number, title: `Change ${number}`, body: '', merged_at: '2026-01-01T00:00:00Z', merged: true, merge_commit_sha: sha(number), head: {ref, sha: sha(number + 500), repo: {full_name: 'org/repo'}}, base: {ref: 'stage', repo: {full_name: 'org/repo'}}, ...extra});
const commit = (s, message) => ({sha: s, commit: {message}});
const SECRET_BLOCK = '<!-- sf-release-notes:start -->\nCloses SF-99\n<!-- sf-release-notes:end -->';
/** A release range: each commit lists the PRs GitHub associates with it. */
function releaseFixture({deployments = [200, [{id: 1, sha: MERGE}, {id: 2, sha: PREV}]], compare = 'ahead', extra = {}, range} = {}) {
  const release = {...pr(), merged_at: '2026-01-02T00:00:00Z', head: {sha: HEAD, ref: 'release/1.2', repo: {full_name: 'org/repo'}}, base: {ref: 'main', repo: {full_name: 'org/repo'}}, body: `Closes SF-6\n${SECRET_BLOCK}`};
  const p = {
    10: repoPr(10, 'SF-1-thing', {body: 'Depends on SF-9. Follow-up to SF-8.'}),
    11: repoPr(11, 'SF-3-feature'),
    12: repoPr(12, 'revert-11-SF-3-feature', {title: 'Revert "Change 11"', body: 'Reverts org/repo#11'}),
    13: repoPr(13, 'main', {body: 'Closes SF-90'}),
    14: repoPr(14, 'csat-sms-step-1', {body: 'Closes [SF-7](https://servefirst.atlassian.net/browse/SF-7)'}),
    15: repoPr(15, 'SF-10-export', {body: 'Closes SF-11', merge_commit_sha: sha(4002)}),
  };
  const rows = range || [
    [commit(sha(1000), 'work on it\n\nCloses SF-2'), [p[10], release]],
    [commit(sha(10), 'Merge pull request #10 from org/SF-1-thing'), [p[10], release]],
    [commit(sha(11), 'Merge pull request #11 from org/SF-3-feature'), [p[11], release]],
    [commit(sha(12), 'Merge pull request #12 from org/revert-11-SF-3-feature'), [p[12], release]],
    [commit(sha(13), 'Merge pull request #13 from org/main\n\nCloses SF-98'), [p[13], release]],
    [commit(sha(14), 'CSAT SMS step 1 (#14)'), [p[14], release]],
    [commit(sha(4001), 'export: first part'), [p[15], release]], // rebase merge: no "#N" anywhere
    [commit(sha(4002), 'export: second part'), [p[15], release]],
    [commit(sha(2000), 'hotfix: cap export cells\n\nCloses SF-5'), [release]],
    [commit(sha(3000), 'chore: bump version to 1.2 SF-97'), [release]],
    [commit(MERGE, 'Merge pull request #7 from org/release/1.2'), [release]],
  ];
  const routes = {
    'GET /pulls/7': release,
    [`GET /commits/${MERGE}/pulls?per_page=100&page=1`]: [200, rows.find(([c]) => c.sha === MERGE)?.[1] || [release]],
    'GET /deployments?environment=production&per_page=100&page=1': deployments,
    'GET /deployments/2/statuses?per_page=100&page=1': [200, [{state: 'inactive'}, {state: 'success'}]],
    [`GET /compare/${PREV}...${MERGE}`]: {status: compare},
    [`GET /compare/${PREV}...${MERGE}?per_page=100&page=1`]: {total_commits: rows.length, commits: rows.map(([c]) => c)},
    [`GET /commits/${MERGE}`]: {sha: MERGE, parents: [{sha: GAP}, {sha: HEAD}]},
    [`GET /compare/${GAP}...${MERGE}?per_page=100&page=1`]: {total_commits: 2, commits: rows.slice(-2).map(([c]) => c)},
  };
  for (const [c, list] of rows) if (c.sha !== MERGE) routes[`GET /commits/${c.sha}/pulls?per_page=100&page=1`] = [200, list];
  return apiFixture({...routes, ...extra});
}

test('ticket rule: branch name or "Closes KEY" only, never a bare mention', () => {
  assert.deepEqual(closingKeys('Closes SF-1'), ['SF-1']);
  assert.deepEqual(closingKeys('closes: sf-2, SF-3 and SF-4.'), ['SF-2', 'SF-3', 'SF-4']);
  assert.deepEqual(closingKeys('Closed [SF-5](https://servefirst.atlassian.net/browse/SF-5)'), ['SF-5']);
  assert.deepEqual(closingKeys('Closes https://servefirst.atlassian.net/browse/SF-6 and also tidies SF-7'), ['SF-6']);
  assert.deepEqual(closingKeys('* Closes SF-14\n> closed: SF-15'), ['SF-14', 'SF-15']);
  for (const text of ['Depends on SF-9', 'We could close SF-8 later', 'enclosed SF-11', 'Fixes SF-12', 'SF-13 in the title', 'This does not mean it closes SF-99', 'Example: Closes SF-98']) assert.deepEqual(closingKeys(text), [], text);
  assert.deepEqual(branchKeys('SF-4401-gridspot-image-lost'), ['SF-4401']);
  assert.deepEqual(branchKeys('feat/SF-12-x'), ['SF-12']);
  assert.deepEqual(branchKeys('csat-sending-phase-4'), []);
  assert.deepEqual(shippedTicketKeys({branch: 'SF-2-a', body: 'Closes SF-1\nSee SF-3', messages: ['Closes SF-2', 'mentions SF-4']}), ['SF-1', 'SF-2']);
});

test('released tickets are rebuilt from GitHub since the last production deploy, not from editable notes', async () => {
  const fixture = releaseFixture();
  const result = await d.releasedTickets({...deployOptions, fetch: fixture.fetch});
  // SF-1 branch, SF-2 commit in PR 10, SF-5 direct hotfix commit, SF-6 release PR description, SF-7 PR description,
  // SF-10/SF-11 rebase-merged PR found through GitHub's commit lookup.
  // Not: SF-9/SF-8 (mentions), SF-3 (reverted), SF-90/SF-98 (sync PR), SF-97 (no "Closes"), SF-99 (inside the notes block).
  assert.deepEqual(result.tickets, ['SF-1', 'SF-10', 'SF-11', 'SF-2', 'SF-5', 'SF-6', 'SF-7']);
  assert.deepEqual(result.warnings, []);
  assert.ok(fixture.calls.every(c => c.init.redirect === 'error' && c.init.signal));
});

test('released tickets: range comes from the previous production deploy, and fails closed without it', async () => {
  // The previous deploy (PREV) is further back than this release's own base (GAP): a release in between never deployed.
  const full = await d.releasedTickets({...deployOptions, fetch: releaseFixture().fetch});
  assert.ok(full.tickets.includes('SF-1'), 'tickets from the undeployed release in between are reported');
  // No earlier production deploy at all: only this release PR's own changes, with a warning.
  const first = await d.releasedTickets({...deployOptions, fetch: releaseFixture({deployments: [200, [{id: 1, sha: MERGE}]]}).fetch});
  assert.deepEqual(first.tickets, ['SF-6']);
  assert.match(first.warnings[0], /No earlier successful production deployment/);
  // Missing deployments permission fails visibly instead of guessing a range.
  await assert.rejects(d.releasedTickets({...deployOptions, fetch: releaseFixture({deployments: [403, {}]}).fetch}), /deployments: read/);
  for (const [compare, pattern] of [['behind', /rollback/], ['identical', /rollback/], ['diverged', /not an ancestor/]]) {
    const result = await d.releasedTickets({...deployOptions, fetch: releaseFixture({compare}).fetch});
    assert.deepEqual(result.tickets, [], compare);
    assert.match(result.warnings[0], pattern);
  }
  await assert.rejects(d.releasedTickets({...deployOptions, fetch: releaseFixture({extra: {'GET /git/ref/tags/v1.2': {object: {type: 'commit', sha: PREV}}}}).fetch}), /Tag does not match/);
});

test('released tickets: reverted content commits and reverted hotfixes report nothing', async () => {
  const release = {...pr(), merged_at: '2026-01-02T00:00:00Z', head: {sha: HEAD, ref: 'release/1.2', repo: {full_name: 'org/repo'}}, base: {ref: 'main', repo: {full_name: 'org/repo'}}, body: ''};
  const feature = repoPr(20, 'SF-20-thing', {merge_commit_sha: sha(20)});
  const hotfix = repoPr(21, 'hotfix/1.1.1', {base: {ref: 'main', repo: {full_name: 'org/repo'}}, body: 'Closes SF-91', merge_commit_sha: sha(21)});
  const range = [
    [commit(sha(5001), 'thing\n\nCloses SF-21'), [feature, release]],
    [commit(sha(20), 'Merge pull request #20 from org/SF-20-thing'), [feature, release]],
    [commit(sha(5002), 'Revert "thing"\n\nThis reverts commit ' + sha(5001) + '.'), [release]],
    [commit(sha(5003), 'fix export\n\nCloses SF-92'), [hotfix, release]],
    [commit(sha(21), 'Merge pull request #21 from org/hotfix/1.1.1'), [hotfix, release]],
    [commit(sha(5004), 'Revert "Merge pull request #21"\n\nThis reverts commit ' + sha(21) + '.'), [release]],
    [commit(sha(5005), 'tidy\n\nCloses SF-93'), [release]],
    [commit(MERGE, 'Merge pull request #7 from org/release/1.2'), [release]],
  ];
  const result = await d.releasedTickets({...deployOptions, fetch: releaseFixture({range, extra: {'GET /pulls/7': release}}).fetch});
  assert.deepEqual(result.tickets, ['SF-93']);
});

test('released tickets: a reverted hotfix drops the PRs merged into it, and the notes block never counts', async () => {
  const release = {...pr(), merged_at: '2026-01-02T00:00:00Z', head: {sha: HEAD, ref: 'release/1.2', repo: {full_name: 'org/repo'}}, base: {ref: 'main', repo: {full_name: 'org/repo'}}, body: ''};
  const hotfix = repoPr(30, 'hotfix/1.1.2', {base: {ref: 'main', repo: {full_name: 'org/repo'}}, merge_commit_sha: sha(30), body: '<!-- sf-release-notes:start -->\nCloses SF-93\n<!-- sf-release-notes:end -->'});
  const feature = repoPr(31, 'SF-71-feature', {base: {ref: 'hotfix/1.1.2', repo: {full_name: 'org/repo'}}, body: 'Closes SF-72', merge_commit_sha: sha(31)});
  const range = [
    [commit(sha(6001), 'feature work'), [feature, hotfix, release]],
    [commit(sha(31), 'Merge pull request #31 from org/SF-71-feature'), [feature, hotfix, release]],
    [commit(sha(30), 'Merge pull request #30 from org/hotfix/1.1.2'), [hotfix, release]],
    [commit(sha(6002), 'Revert hotfix\n\nThis reverts commit ' + sha(30) + '.'), [release]],
    [commit(sha(6003), 'tidy\n\nCloses SF-93'), [release]],
    [commit(MERGE, 'Merge pull request #7 from org/release/1.2'), [release]],
  ];
  const result = await d.releasedTickets({...deployOptions, fetch: releaseFixture({range, extra: {'GET /pulls/7': release}}).fetch});
  // SF-71/SF-72 were undone with the hotfix. SF-93 is only "closed" inside the hotfix's notes block, which never counts.
  assert.deepEqual(result.tickets, ['SF-93']);
});

test('released tickets: deployment statuses and history are read to the end, or fail closed', async () => {
  const statuses = Array.from({length: 100}, () => ({state: 'inactive'}));
  const paged = releaseFixture({extra: {
    'GET /deployments/2/statuses?per_page=100&page=1': [200, statuses],
    'GET /deployments/2/statuses?per_page=100&page=2': [200, [{state: 'success'}]],
  }});
  assert.ok((await d.releasedTickets({...deployOptions, fetch: paged.fetch})).tickets.includes('SF-1'));
  assert.ok(paged.calls.some(c => c.key === 'GET /deployments/2/statuses?per_page=100&page=2'));
  const full = Array.from({length: 100}, (_, i) => ({id: 1000 + i, sha: sha(7000 + i)}));
  const pages = Object.fromEntries(Array.from({length: 10}, (_, i) => [`GET /deployments?environment=production&per_page=100&page=${i + 1}`, [200, full]]));
  for (const {id} of full) pages[`GET /deployments/${id}/statuses?per_page=100&page=1`] = [200, [{state: 'failure'}]];
  await assert.rejects(d.releasedTickets({...deployOptions, fetch: releaseFixture({extra: pages}).fetch}), /Too many production deployments/);
});

test('released tickets: fork PRs from a branch named main count; notes-block "Reverts" never drops tickets', async () => {
  const release = {...pr(), merged_at: '2026-01-02T00:00:00Z', head: {sha: HEAD, ref: 'release/1.2', repo: {full_name: 'org/repo'}}, base: {ref: 'main', repo: {full_name: 'org/repo'}}, body: ''};
  const fork = repoPr(40, 'main', {head: {ref: 'main', sha: sha(940), repo: {full_name: 'contributor/repo'}}, body: 'Closes SF-77'});
  const feature = repoPr(41, 'SF-93-thing');
  const other = repoPr(42, 'SF-94-other');
  const revert = repoPr(43, 'revert-42-SF-94-other', {title: 'Revert "Change 42"', body: 'Reverts org/repo#42\n<!-- sf-release-notes:start -->\nReverts org/repo#41\n<!-- sf-release-notes:end -->'});
  const range = [40, 41, 42, 43].map(n => [commit(sha(n), `Merge pull request #${n} from x/y`), [{40: fork, 41: feature, 42: other, 43: revert}[n], release]]);
  range.push([commit(MERGE, 'Merge pull request #7 from org/release/1.2'), [release]]);
  const result = await d.releasedTickets({...deployOptions, fetch: releaseFixture({range, extra: {'GET /pulls/7': release}}).fetch});
  assert.deepEqual(result.tickets, ['SF-77', 'SF-93']);
});

test('released tickets: hotfix-named feature branches keep their branch ticket', async () => {
  const release = {...pr(), merged_at: '2026-01-02T00:00:00Z', head: {sha: HEAD, ref: 'release/1.2', repo: {full_name: 'org/repo'}}, base: {ref: 'main', repo: {full_name: 'org/repo'}}, body: ''};
  const toStage = repoPr(50, 'hotfix/SF-77-export', {body: null});
  const toMain = repoPr(51, 'hotfix/SF-78-cells', {base: {ref: 'main', repo: {full_name: 'org/repo'}}, body: null});
  const range = [[commit(sha(50), 'neutral'), [toStage, release]], [commit(sha(51), 'neutral'), [toMain, release]], [commit(MERGE, 'Merge pull request #7 from org/release/1.2'), [release]]];
  const result = await d.releasedTickets({...deployOptions, fetch: releaseFixture({range, extra: {'GET /pulls/7': release}}).fetch});
  assert.deepEqual(result.tickets, ['SF-77', 'SF-78']);
});

test('released tickets: reverting a commit inside a hotfix drops the hotfix branch ticket only', async () => {
  const release = {...pr(), merged_at: '2026-01-02T00:00:00Z', head: {sha: HEAD, ref: 'release/1.2', repo: {full_name: 'org/repo'}}, base: {ref: 'main', repo: {full_name: 'org/repo'}}, body: 'Closes SF-6'};
  const hotfix = repoPr(60, 'hotfix/SF-78-cells', {base: {ref: 'main', repo: {full_name: 'org/repo'}}, body: null});
  const range = [
    [commit(sha(8001), 'neutral fix'), [hotfix, release]],
    [commit(sha(60), 'Merge pull request #60 from org/hotfix/SF-78-cells'), [hotfix, release]],
    [commit(sha(8002), 'Revert "neutral fix"\n\nThis reverts commit ' + sha(8001) + '.'), [release]],
    [commit(MERGE, 'Merge pull request #7 from org/release/1.2'), [release]],
  ];
  const result = await d.releasedTickets({...deployOptions, fetch: releaseFixture({range, extra: {'GET /pulls/7': release}}).fetch});
  assert.deepEqual(result.tickets, ['SF-6']);
});

test('released tickets: long deployment history is fine when the previous deploy is near the top', async () => {
  const full = [{id: 1, sha: MERGE}, {id: 2, sha: PREV}, ...Array.from({length: 98}, (_, i) => ({id: 1000 + i, sha: sha(7000 + i)}))];
  const fixture = releaseFixture({deployments: [200, full]});
  assert.ok((await d.releasedTickets({...deployOptions, fetch: fixture.fetch})).tickets.includes('SF-1'));
  assert.ok(!fixture.calls.some(c => c.key.includes('deployments?environment=production&per_page=100&page=2')), 'stops reading once the previous deploy is known');
});

test('Jira webhook requires current endpoint and secret, batches, and never leaks errors', async () => {
  for (const bad of [undefined, 'http://api-private.atlassian.com/automation/webhooks/jira/a/x/y', 'https://api-private.atlassian.com.evil.test/automation/webhooks/jira/a/x/y', 'https://automation.atlassian.com/pro/hooks/abc', JIRA_HOOK + '?x=1']) {
    await assert.rejects(d.sendJiraRelease({webhook: bad, secret: 'shh', tickets: ['SF-1'], fetch: () => assert.fail('Bad webhook fetched')}), /Invalid Jira automation webhook URL/);
  }
  for (const secret of [undefined, '', 'a\nb']) await assert.rejects(d.sendJiraRelease({webhook: JIRA_HOOK, secret, tickets: ['SF-1'], fetch: () => assert.fail('No secret')}), /secret is required/);
  assert.deepEqual(await d.sendJiraRelease({webhook: JIRA_HOOK, secret: 'shh', tickets: [], fetch: () => assert.fail('No tickets')}), {sent: false, skipped: true, tickets: 0});
  await assert.rejects(d.sendJiraRelease({webhook: JIRA_HOOK, secret: 'shh', tickets: ['sf-1'], fetch: () => assert.fail('Bad key fetched')}), /Invalid Jira ticket keys/);
  const posts = [];
  const tickets = Array.from({length: 120}, (_, i) => `SF-${i + 1}`);
  const result = await d.sendJiraRelease({webhook: JIRA_HOOK, secret: 'shh', tickets, repository: 'org/repo', version: '1.2', notesUrl: 'https://github.com/org/repo/pull/7',
    fetch: async (url, init) => { posts.push({url, init, body: JSON.parse(init.body)}); return new Response('{}'); }});
  assert.deepEqual(result, {sent: true, skipped: false, tickets: 120});
  assert.deepEqual(posts.map(p => p.body.issues.length), [50, 50, 20]);
  assert.deepEqual(posts.flatMap(p => p.body.issues), tickets);
  assert.deepEqual(posts[0].body.data, {repository: 'org/repo', version: '1.2', notesUrl: 'https://github.com/org/repo/pull/7'});
  assert.equal(posts[0].init.headers['X-Automation-Webhook-Token'], 'shh');
  assert.equal(posts[0].init.redirect, 'error');
  assert.ok(posts[0].init.signal);
  let call = 0;
  await assert.rejects(d.sendJiraRelease({webhook: JIRA_HOOK, secret: 'shh', tickets, fetch: async () => new Response('', {status: ++call === 2 ? 500 : 200})}), /after 50 of 120 ticket\(s\) \(HTTP 500\); rerun/);
  for (const fetch of [async () => new Response('secret body', {status: 401}), async () => { throw new Error(JIRA_HOOK); }]) {
    await assert.rejects(d.sendJiraRelease({webhook: JIRA_HOOK, secret: 'shh', tickets: ['SF-1'], fetch}), error => !/secret|shh|atlassian/.test(error.message));
  }
});

test('notification CLI: Jira only for successful production, independent of Slack', async () => {
  const {main} = await import('../scripts/notify-deployment.mjs');
  const env = {GITHUB_REPOSITORY: 'org/repo', GH_TOKEN: 'secret', DEPLOYED_SHA: MERGE, VERSION: '1.2', ENVIRONMENT: 'production', DEPLOY_STATUS: 'success', RUN_URL: deployOptions.runUrl, JIRA_WEBHOOK_URL: JIRA_HOOK, JIRA_WEBHOOK_SECRET: 'shh'};
  const withPosts = (slackStatus = 200) => {
    const fixture = releaseFixture({extra: {'GET /releases/tags/v1.2': [404, {}]}}), jira = [];
    const fetch = async (url, init) => {
      if (url === JIRA_HOOK) { jira.push(JSON.parse(init.body)); return new Response('{}'); }
      if (url.startsWith('https://hooks.slack.com/')) return new Response('', {status: slackStatus});
      return fixture.fetch(url, init);
    };
    return {fetch, jira};
  };
  const quiet = {log: () => {}, warn: () => {}};
  const jiraOnly = withPosts();
  const result = await main(env, {fetch: jiraOnly.fetch, ...quiet});
  assert.equal(result.jira.sent, true);
  assert.deepEqual(jiraOnly.jira.map(b => b.issues), [['SF-1', 'SF-10', 'SF-11', 'SF-2', 'SF-5', 'SF-6', 'SF-7']]);
  assert.equal(jiraOnly.jira[0].data.notesUrl, 'https://github.com/org/repo/pull/7');
  const slackDown = withPosts(500);
  await assert.rejects(main({...env, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T1/B2/S3'}, {fetch: slackDown.fetch, ...quiet}), /Slack delivery failed/);
  assert.equal(slackDown.jira.length, 1);
  // Staging and failed deploys never validate or call Jira, even with a broken Jira config.
  for (const extra of [{ENVIRONMENT: 'staging'}, {DEPLOY_STATUS: 'failure', DEPLOYED_SHA: '', VERSION: ''}]) {
    const other = withPosts();
    await main({...env, ...extra, JIRA_WEBHOOK_URL: 'https://not-jira.test/x', JIRA_WEBHOOK_SECRET: ''}, {fetch: other.fetch, ...quiet});
    assert.deepEqual(other.jira, []);
  }
  const dry = withPosts(), logs = [];
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  try {
    await main({...env, DRY_RUN: 'true', PAYLOAD_FILE: join(directory, 'p.json')}, {fetch: dry.fetch, log: line => logs.push(line), warn: () => {}});
  } finally { await rm(directory, {recursive: true, force: true}); }
  assert.deepEqual(dry.jira, []);
  assert.ok(logs.some(line => /would report 7 released ticket\(s\): SF-1, SF-10, SF-11, SF-2, SF-5, SF-6, SF-7/.test(line)));
});
