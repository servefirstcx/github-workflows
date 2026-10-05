import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import * as d from '../scripts/delivery.mjs';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atlassianFake, EMAIL, TOKEN} from './atlassian-fixture.mjs';

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
// Answers the batched associatedPullRequests GraphQL query from the same
// `GET /commits/{sha}/pulls` routes the REST fallback uses, so one fixture covers both.
// The slice of GitHub's PullRequest schema the query uses: true = scalar, object = needs a sub-selection.
const PR_SCHEMA = {number: true, title: true, body: true, mergedAt: true, baseRefName: true, headRefName: true,
  mergeCommit: {oid: true}, baseRepository: {nameWithOwner: true}, headRepository: {nameWithOwner: true}, author: {login: true}};

// "a b { c } d" -> {a: true, b: {c: true}, d: true}, checked against PR_SCHEMA the way GitHub
// would: unknown fields, a sub-selection on a scalar or a bare object field are errors.
// Deliberately tiny: aliases, directives, arguments and fragments fail outright, so this
// fixture can never answer with a field real GraphQL would have renamed, omitted or rejected.
function parseSelection(text, schema = PR_SCHEMA) {
  assert.match(text, /^[A-Za-z_{}\s]*$/, `Unsupported GraphQL selection syntax in fixture: ${text}`);
  const tokens = text.match(/[A-Za-z_]+|[{}]/g) || [];
  const read = type => {
    const out = {};
    while (tokens.length && tokens[0] !== '}') {
      const name = tokens.shift();
      assert.ok(name !== '{' && Object.hasOwn(type, name), `Unknown GraphQL field in fixture: ${name}`);
      if (tokens[0] === '{') {
        assert.ok(type[name] !== true, `Sub-selection on scalar field ${name}`);
        tokens.shift(); out[name] = read(type[name]);
        assert.equal(tokens.shift(), '}', `Unclosed selection on ${name}`);
        assert.ok(Object.keys(out[name]).length, `Empty selection on ${name}`);
      } else {
        assert.ok(type[name] === true, `Object field ${name} needs a sub-selection`);
        out[name] = true;
      }
    }
    return out;
  };
  const result = read(schema);
  assert.equal(tokens.length, 0, `Unbalanced GraphQL selection in fixture: ${text}`);
  return result;
}

function pick(value, selection) {
  if (value === null || value === undefined) return value;
  if (selection === true) { assert.ok(typeof value !== 'object', 'Scalar selection returned an object'); return value; }
  return Object.fromEntries(Object.entries(selection).filter(([k]) => k in value).map(([k, sub]) => [k, pick(value[k], sub)]));
}

// A fixture mistake inside a GraphQL reply would otherwise be swallowed by the production REST
// fallback and look like a pass, so every one is recorded and fails the file in after().
const FIXTURE_ERRORS = [];
after(() => assert.deepEqual(FIXTURE_ERRORS, [], 'GraphQL fixture errors were hidden by the REST fallback'));

function graphqlFromRest(routes, request) {
  const override = routes['POST /graphql'];
  let value;
  try { value = override ? (typeof override === 'function' ? override(request) : override) : graphqlData(routes, request); }
  catch (error) { FIXTURE_ERRORS.push(error.message); throw error; }
  const [status, data] = Array.isArray(value) ? value : [200, value];
  return new Response(JSON.stringify(data), {status});
}

function graphqlData(routes, {query, variables}) {
  // The whole query must be exactly the supported shape: variables, repository(owner, name), one
  // `cN: object(oid: $cN) { ... on Commit { associatedPullRequests(first: 100) { totalCount nodes {...} } } }`
  // per commit, nothing else. Aliases, directives, a different page size or a renamed field
  // anywhere fail here instead of being answered as if GitHub had accepted them.
  const aliases = Object.keys(variables).filter(k => /^c\d+$/.test(k));
  assert.deepEqual(Object.keys(variables).sort(), ['name', 'owner', ...aliases].sort(), 'Unexpected GraphQL variables');
  const flat = query.replace(/\s+/g, ' ').trim();
  const head = `query($owner: String!, $name: String!, ${aliases.map(a => `$${a}: GitObjectID!`).join(', ')}) { repository(owner: $owner, name: $name) { `;
  assert.ok(flat.startsWith(head), `Unexpected GraphQL query head: ${flat.slice(0, 160)}`);
  let rest = flat.slice(head.length);
  for (const alias of aliases) {
    const prefix = `${alias}: object(oid: $${alias}) { ... on Commit { associatedPullRequests(first: 100) { totalCount nodes { `;
    assert.ok(rest.startsWith(prefix), `Unexpected GraphQL selection for ${alias}: ${rest.slice(0, 160)}`);
    rest = rest.slice(prefix.length);
    // Close of `nodes {`, by brace depth (the PR fields contain their own braces).
    let depth = 1, end = 0;
    for (; end < rest.length && depth; end++) { if (rest[end] === '{') depth++; else if (rest[end] === '}') depth--; }
    assert.equal(depth, 0, `Unclosed GraphQL selection for ${alias}`);
    parseSelection(rest.slice(0, end - 1)); // PR fields, checked against PR_SCHEMA
    rest = rest.slice(end);
    // associatedPullRequests, ... on Commit, object
    assert.ok(rest.startsWith(' } } }'), `Unexpected GraphQL selection after nodes for ${alias}: ${rest.slice(0, 80)}`);
    rest = rest.slice(' } } }'.length).trimStart();
  }
  assert.equal(rest, '} }', `Unexpected GraphQL query tail: ${rest.slice(0, 160)}`);
  assert.equal(variables.owner, 'org'); assert.equal(variables.name, 'repo');
  const repository = {};
  for (const [alias, sha] of Object.entries(variables).filter(([k]) => /^c\d+$/.test(k))) {
    assert.match(query, new RegExp(`${alias}: object\\(oid: \\$${alias}\\)`));
    const first = routes[`GET /commits/${sha}/pulls?per_page=100&page=1`];
    assert.ok(first, `Unexpected GraphQL commit ${sha}`);
    const pages = [];
    for (let page = 1; routes[`GET /commits/${sha}/pulls?per_page=100&page=${page}`]; page++) {
      const value = routes[`GET /commits/${sha}/pulls?per_page=100&page=${page}`];
      const [status, list] = Array.isArray(value) && typeof value[0] === 'number' ? value : [200, value];
      if (status !== 200) return [status, {}];
      pages.push(...list);
      if (list.length < 100) break;
    }
    // Only the fields (and nested fields) the query actually selects, so changing PR_FIELDS fails tests.
    // The braces after this alias's "nodes", matched by depth rather than a regex, so a short cut can't pass.
    const at = query.indexOf(`${alias}: object(`), open = query.indexOf('nodes {', at) + 'nodes '.length;
    assert.ok(at >= 0 && open > at, `No nodes selection for ${alias}`);
    let depth = 0, close = open;
    for (; close < query.length; close++) { if (query[close] === '{') depth++; else if (query[close] === '}' && --depth === 0) break; }
    const selection = parseSelection(query.slice(open + 1, close));
    const full = p => ({number: p.number, title: p.title, body: p.body, mergedAt: p.merged_at || null,
      mergeCommit: p.merge_commit_sha ? {oid: p.merge_commit_sha} : null,
      baseRefName: p.base?.ref, baseRepository: p.base?.repo ? {nameWithOwner: p.base.repo.full_name} : null,
      headRefName: p.head?.ref, headRepository: p.head?.repo ? {nameWithOwner: p.head.repo.full_name} : null,
      author: p.user ? {login: p.user.login} : null});
    const nodes = pages.map(p => pick(full(p), selection));
    repository[alias] = {associatedPullRequests: {totalCount: nodes.length, nodes: nodes.slice(0, 100)}};
  }
  return {data: {repository}};
}

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
    if (key === 'POST /graphql') return graphqlFromRest(routes, body);
    assert.ok(key in routes, `Unexpected request ${key}`);
    const value = typeof routes[key] === 'function' ? routes[key](body) : routes[key];
    const [status, data] = Array.isArray(value) ? value : [200, value];
    return new Response(JSON.stringify(data), {status});
  };
  return {fetch, calls, graphql: request => graphqlData(routes, request)};
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
const repoPr = (number, ref, extra = {}) => ({number, title: `Change ${number}`, body: '', merged_at: '2026-01-01T00:00:00Z', merged: true, merge_commit_sha: sha(number), head: {ref, sha: sha(number + 500), repo: {full_name: 'org/repo'}}, base: {ref: 'stage', repo: {full_name: 'org/repo'}}, user: {login: `dev${number}`}, ...extra});
const commit = (s, message) => ({sha: s, commit: {message}});
const SECRET_BLOCK = '<!-- sf-release-notes:start -->\nCloses SF-99\n<!-- sf-release-notes:end -->';
/** A release range: each commit lists the PRs GitHub associates with it. */
const releasePrFor = () => ({...pr(), merged_at: '2026-01-02T00:00:00Z', head: {sha: HEAD, ref: 'release/1.2', repo: {full_name: 'org/repo'}}, base: {ref: 'main', repo: {full_name: 'org/repo'}}, body: 'Closes SF-6'});

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
  // Only the hotfix fix commit reached production without a PR: version bumps, the release merge,
  // sync/merge commits and PR commits are not "direct".
  assert.deepEqual(result.directCommits.map(c => [c.sha, c.title, c.tickets]), [[sha(2000), 'hotfix: cap export cells', ['SF-5']]]);
  assert.ok(fixture.calls.every(c => c.init.redirect === 'error' && c.init.signal));
});

test('released tickets: only work that came through a hotfix PR is a hotfix ticket', async () => {
  const main = {ref: 'main', repo: {full_name: 'org/repo'}};
  const hotfixPr = {...pr(), merged_at: '2026-01-03T00:00:00Z', head: {sha: HEAD, ref: 'hotfix/1.2.1', repo: {full_name: 'org/repo'}}, base: main, body: 'Closes SF-80'};
  // An earlier release merged to main but never deployed, so it rides in the hotfix's range.
  const earlier = repoPr(40, 'release/1.2.0', {base: main, body: 'Closes SF-41'});
  const feature = repoPr(42, 'SF-42-feature');
  const intoHotfix = repoPr(43, 'SF-83-fix', {base: {ref: 'hotfix/1.2.1', repo: {full_name: 'org/repo'}}});
  const range = [
    [commit(sha(42), 'Merge pull request #42 from org/SF-42-feature'), [feature, earlier]],
    [commit(sha(40), 'Merge pull request #40 from org/release/1.2.0'), [earlier]],
    [commit(sha(7001), 'fix export\n\nCloses SF-81'), [hotfixPr]],
    [commit(sha(43), 'Merge pull request #43 from org/SF-83-fix'), [intoHotfix, hotfixPr]],
    [commit(MERGE, 'Merge pull request #7 from org/hotfix/1.2.1'), [hotfixPr]],
  ];
  const deployed = await d.releasedTickets({...deployOptions, fetch: releaseFixture({range, extra: {'GET /pulls/7': hotfixPr}}).fetch});
  assert.deepEqual(deployed.tickets, ['SF-41', 'SF-42', 'SF-80', 'SF-81', 'SF-83']);
  // The hotfix's description, fix commit and the PR merged into it; not the earlier release's feature or "Closes" line.
  assert.deepEqual(deployed.hotfixTickets, ['SF-80', 'SF-81', 'SF-83']);
  // The other way round: a release deploy that also ships a hotfix that never deployed reports its tickets as hotfix.
  const releasePr = releasePrFor();
  const undeployed = repoPr(44, 'hotfix/1.1.1', {base: main, body: 'Closes SF-84'});
  const later = [
    [commit(sha(7002), 'cap cells\n\nCloses SF-85'), [undeployed, releasePr]],
    [commit(sha(44), 'Merge pull request #44 from org/hotfix/1.1.1'), [undeployed, releasePr]],
    [commit(sha(42), 'Merge pull request #42 from org/SF-42-feature'), [feature, releasePr]],
    [commit(MERGE, 'Merge pull request #7 from org/release/1.2'), [releasePr]],
  ];
  const shipped = await d.releasedTickets({...deployOptions, fetch: releaseFixture({range: later, extra: {'GET /pulls/7': releasePr}}).fetch});
  assert.deepEqual(shipped.tickets, ['SF-42', 'SF-6', 'SF-84', 'SF-85']);
  assert.deepEqual(shipped.hotfixTickets, ['SF-84', 'SF-85']);
  // A plain release has none.
  assert.deepEqual((await d.releasedTickets({...deployOptions, fetch: releaseFixture().fetch})).hotfixTickets, []);
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
  assert.deepEqual(result.pullRequests, []);
  assert.deepEqual(result.reverted.pullRequests.map(pr => [pr.number, pr.reason]), [[20, 'reverted']]);
  assert.deepEqual(result.reverted.tickets, ['SF-20', 'SF-21', 'SF-91', 'SF-92']);
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
  // The hotfix wrapper (#30) is in neither PR list; the PR merged into it went with it.
  assert.deepEqual(result.pullRequests, []);
  assert.deepEqual(result.reverted.pullRequests.map(pr => [pr.number, pr.reason]), [[31, 'reverted']]);
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
  assert.deepEqual(result.pullRequests.map(pr => pr.number), [40, 41]);
  assert.deepEqual(result.reverted.pullRequests.map(pr => [pr.number, pr.reason]), [[42, 'reverted'], [43, 'revert']]);
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
  // The reverted fix and its revert are not listed as shipped direct commits.
  assert.deepEqual(result.directCommits, []);
});

test('released tickets: a deployed hotfix whose fix was reverted reports nothing', async () => {
  const hotfix = {...pr(), merged_at: '2026-01-02T00:00:00Z', head: {sha: HEAD, ref: 'hotfix/SF-78-cells', repo: {full_name: 'org/repo'}}, base: {ref: 'main', repo: {full_name: 'org/repo'}}, body: null};
  const range = [
    [commit(sha(8101), 'neutral fix'), [hotfix]],
    [commit(sha(8102), 'Revert "neutral fix"\n\nThis reverts commit ' + sha(8101) + '.'), [hotfix]],
    [commit(MERGE, 'Merge pull request #7 from org/hotfix/SF-78-cells'), [hotfix]],
  ];
  const result = await d.releasedTickets({...deployOptions, fetch: releaseFixture({range, extra: {'GET /pulls/7': hotfix}}).fetch});
  assert.deepEqual(result.tickets, []);
  assert.deepEqual(result.directCommits, [], 'Undone hotfix work is not listed as shipped');
  const kept = await d.releasedTickets({...deployOptions, fetch: releaseFixture({range: [range[0], range[2]], extra: {'GET /pulls/7': hotfix}}).fetch});
  assert.deepEqual(kept.tickets, ['SF-78']);
  // A fix on hotfix/SF-78-… is covered by the branch ticket, so it isn't flagged as having no ticket.
  assert.deepEqual(kept.directCommits.map(c => [c.sha, c.title, c.tickets]), [[sha(8101), 'neutral fix', ['SF-78']]]);
});

test('released tickets: redeploying an already deployed commit reports nothing; a failed earlier attempt does not count', async () => {
  const redeploy = releaseFixture({deployments: [200, [{id: 1, sha: MERGE}, {id: 3, sha: MERGE}, {id: 2, sha: PREV}]], extra: {
    'GET /deployments/3/statuses?per_page=100&page=1': [200, [{state: 'inactive'}, {state: 'success'}]],
  }});
  const result = await d.releasedTickets({...deployOptions, fetch: redeploy.fetch});
  assert.deepEqual(result.tickets, []);
  assert.match(result.warnings[0], /already deployed/);
  const retried = releaseFixture({deployments: [200, [{id: 1, sha: MERGE}, {id: 3, sha: MERGE}, {id: 2, sha: PREV}]], extra: {
    'GET /deployments/3/statuses?per_page=100&page=1': [200, [{state: 'failure'}]],
  }});
  assert.ok((await d.releasedTickets({...deployOptions, fetch: retried.fetch})).tickets.includes('SF-1'));
});

test('released tickets: commits are matched to PRs 100 at a time over GraphQL, not one REST call each', async () => {
  const many = Array.from({length: 150}, (_, i) => [commit(sha(5000 + i), `change ${i}\n\nCloses SF-${1000 + i}`), [repoPr(500 + i, `SF-${2000 + i}-x`, {merge_commit_sha: sha(5000 + i)})]]);
  const range = [...many, [commit(MERGE, 'Merge pull request #7 from org/release/1.2'), [releasePrFor()]]];
  const fixture = releaseFixture({range});
  const result = await d.releasedTickets({...deployOptions, fetch: fixture.fetch});
  assert.equal(result.tickets.length, 301); // 150 Closes + 150 branch keys + SF-6 on the release PR
  assert.equal(fixture.calls.filter(c => c.key === 'POST /graphql').length, 2);
  assert.equal(fixture.calls.filter(c => /^GET \/commits\/[a-f0-9]{40}\/pulls/.test(c.key) && !c.key.includes(MERGE)).length, 0);
  assert.equal(fixture.calls[fixture.calls.findIndex(c => c.key === 'POST /graphql')].init.headers.Authorization, 'Bearer secret');
});

test('released tickets: a commit in more than 100 PRs falls back to paginated REST', async () => {
  const crowded = Array.from({length: 100}, (_, i) => ({number: 900 + i, merged_at: null}));
  const range = [[commit(sha(6000), 'busy commit'), [...crowded, repoPr(42, 'SF-42-busy', {merge_commit_sha: sha(6000)})]],
    [commit(MERGE, 'Merge pull request #7 from org/release/1.2'), [releasePrFor()]]];
  const fixture = releaseFixture({range, extra: {
    [`GET /commits/${sha(6000)}/pulls?per_page=100&page=1`]: [200, crowded],
    [`GET /commits/${sha(6000)}/pulls?per_page=100&page=2`]: [200, [repoPr(42, 'SF-42-busy', {merge_commit_sha: sha(6000)})]],
  }});
  const result = await d.releasedTickets({...deployOptions, fetch: fixture.fetch});
  assert.ok(result.tickets.includes('SF-42'));
  assert.ok(fixture.calls.some(c => c.key.endsWith(`${sha(6000)}/pulls?per_page=100&page=2`)));
});

test('released tickets: a failed GraphQL batch falls back to REST and gives the same tickets', async () => {
  const expected = (await d.releasedTickets({...deployOptions, fetch: releaseFixture().fetch})).tickets;
  for (const reply of [[200, {errors: [{message: 'timeout'}], data: {repository: {}}}], [502, {}], [403, {}]]) {
    const fixture = releaseFixture({extra: {'POST /graphql': reply}});
    assert.deepEqual((await d.releasedTickets({...deployOptions, fetch: fixture.fetch})).tickets, expected);
    assert.ok(fixture.calls.some(c => /^GET \/commits\/[a-f0-9]{40}\/pulls/.test(c.key) && !c.key.includes(MERGE)));
  }
});

test('released tickets: a missing commit, or GraphQL and REST both failing, fails closed', async () => {
  await assert.rejects(d.releasedTickets({...deployOptions, fetch: releaseFixture({extra: {'POST /graphql': [200, {data: {repository: {}}}]}}).fetch}), /associated pull request/);
  const down = releaseFixture({extra: {'POST /graphql': [502, {}], [`GET /commits/${sha(10)}/pulls?per_page=100&page=1`]: [502, {}]}});
  await assert.rejects(d.releasedTickets({...deployOptions, fetch: down.fetch}), /GitHub request failed/);
});

test('released tickets: a null PR node is resolved over REST, so a revert is not missed', async () => {
  const expected = (await d.releasedTickets({...deployOptions, fetch: releaseFixture().fetch})).tickets;
  assert.ok(!expected.includes('SF-3'));
  const base = releaseFixture();
  const withNull = releaseFixture({extra: {'POST /graphql': ({query, variables}) => {
    const reply = structuredClone(base.graphql({query, variables}));
    for (const value of Object.values(reply.data.repository)) {
      value.associatedPullRequests.nodes = value.associatedPullRequests.nodes.map(n => n.number === 12 ? null : n);
    }
    return reply;
  }}});
  assert.deepEqual((await d.releasedTickets({...deployOptions, fetch: withNull.fetch})).tickets, expected);
});

test('released tickets: a PR from a deleted fork keeps its branch ticket and is never a sync PR', async () => {
  const forkPr = {...repoPr(77, 'SF-77-from-fork', {merge_commit_sha: sha(7700)}), head: {ref: 'SF-77-from-fork', repo: null}};
  const range = [[commit(sha(7700), 'Merge pull request #77 from gone/SF-77-from-fork'), [forkPr]],
    [commit(MERGE, 'Merge pull request #7 from org/release/1.2'), [releasePrFor()]]];
  const result = await d.releasedTickets({...deployOptions, fetch: releaseFixture({range}).fetch});
  assert.deepEqual(result.tickets, ['SF-6', 'SF-77']);
});

test('GraphQL fixture rejects aliases, directives, unknown fields and bare object fields instead of guessing', () => {
  assert.deepEqual(parseSelection('number mergeCommit { oid } headRepository { nameWithOwner }'), {number: true, mergeCommit: {oid: true}, headRepository: {nameWithOwner: true}});
  for (const text of ['mergeCommit { renamed: oid }', 'mergeCommit { oid @skip(if: true) }', 'number ...F']) assert.throws(() => parseSelection(text), /Unsupported GraphQL selection/);
  for (const text of ['mergeCommit', 'baseRepository', 'headRepository', 'author', 'author { name }', 'number { x }', 'mergeCommit { }', 'mergeCommit { id }', 'nope', 'number }', 'mergeCommit { oid']) assert.throws(() => parseSelection(text), /GraphQL|selection|field/, text);
});

test('GraphQL fixture rejects any change to the query shape outside the PR fields', () => {
  const routes = {[`GET /commits/${sha(1)}/pulls?per_page=100&page=1`]: [200, []]};
  const vars = {owner: 'org', name: 'repo', c0: sha(1)};
  const good = `query($owner: String!, $name: String!, $c0: GitObjectID!) {
      repository(owner: $owner, name: $name) {
        c0: object(oid: $c0) { ... on Commit { associatedPullRequests(first: 100) { totalCount nodes { number mergeCommit { oid } } } } }
      }
    }`;
  assert.deepEqual(graphqlData(routes, {query: good, variables: vars}), {data: {repository: {c0: {associatedPullRequests: {totalCount: 0, nodes: []}}}}});
  for (const [from, to] of [['totalCount ', ''], ['totalCount', 'count: totalCount'], ['nodes {', 'renamed: nodes {'],
    ['associatedPullRequests(', 'prs: associatedPullRequests('], ['(first: 100)', '(first: 100) @skip(if: true)'],
    ['repository(owner: $owner, name: $name)', 'repository(owner: $owner, name: $name) @skip(if: true)'], ['first: 100', 'first: 1'],
    ['c0: object', 'x0: object'], ['... on Commit', '... on Tree']]) {
    assert.throws(() => graphqlData(routes, {query: good.replace(from, to), variables: vars}), /GraphQL/, `${from} -> ${to}`);
  }
  assert.throws(() => graphqlData(routes, {query: good, variables: {...vars, extra: 1}}), /variables/);
});

test('released tickets: dropping a selected GraphQL field changes the result (fixture honours the query)', async () => {
  const fixture = releaseFixture();
  const original = fixture.fetch;
  const strip = async (url, init = {}) => {
    if (String(url).endsWith('/graphql')) {
      const body = JSON.parse(init.body);
      body.query = body.query.replaceAll('number title body mergedAt', 'number title mergedAt');
      init = {...init, body: JSON.stringify(body)};
    }
    return original(url, init);
  };
  const full = (await d.releasedTickets({...deployOptions, fetch: releaseFixture().fetch})).tickets;
  const noBody = (await d.releasedTickets({...deployOptions, fetch: strip})).tickets;
  assert.notDeepEqual(noBody, full);
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
  assert.deepEqual(await d.sendJiraRelease({webhook: JIRA_HOOK, secret: 'shh', tickets: [], fetch: () => assert.fail('No tickets')}), {sent: false, skipped: true, tickets: 0, hotfixTickets: 0});
  await assert.rejects(d.sendJiraRelease({webhook: JIRA_HOOK, secret: 'shh', tickets: ['sf-1'], fetch: () => assert.fail('Bad key fetched')}), /Invalid Jira ticket keys/);
  const posts = [];
  const tickets = Array.from({length: 120}, (_, i) => `SF-${i + 1}`);
  const result = await d.sendJiraRelease({webhook: JIRA_HOOK, secret: 'shh', tickets, repository: 'org/repo', version: '1.2', notesUrl: 'https://github.com/org/repo/pull/7',
    fetch: async (url, init) => { posts.push({url, init, body: JSON.parse(init.body)}); return new Response('{}'); }});
  assert.deepEqual(result, {sent: true, skipped: false, tickets: 120, hotfixTickets: 0});
  assert.deepEqual(posts.map(p => p.body.issues.length), [50, 50, 20]);
  assert.deepEqual(posts.flatMap(p => p.body.issues), tickets);
  assert.deepEqual(posts[0].body.data, {repository: 'org/repo', version: '1.2', notesUrl: 'https://github.com/org/repo/pull/7', releaseType: 'release'});
  // Hotfix tickets go in their own requests, so only they get the rule's wider status gate.
  const mixed = [];
  const mixedResult = await d.sendJiraRelease({webhook: JIRA_HOOK, secret: 'shh', tickets: ['SF-1', 'SF-2', 'SF-3'], hotfixTickets: ['SF-2'], repository: 'org/repo', version: '1.2.1', notesUrl: null,
    fetch: async (url, init) => { mixed.push(JSON.parse(init.body)); return new Response('{}'); }});
  assert.deepEqual(mixed.map(b => [b.data.releaseType, b.issues]), [['release', ['SF-1', 'SF-3']], ['hotfix', ['SF-2']]]);
  assert.deepEqual(mixedResult, {sent: true, skipped: false, tickets: 3, hotfixTickets: 1});
  const onlyHotfix = [];
  await d.sendJiraRelease({webhook: JIRA_HOOK, secret: 'shh', tickets: ['SF-1'], hotfixTickets: ['SF-1'], fetch: async (url, init) => { onlyHotfix.push(JSON.parse(init.body)); return new Response('{}'); }});
  assert.deepEqual(onlyHotfix.map(b => [b.data.releaseType, b.issues]), [['hotfix', ['SF-1']]], 'No empty release request');
  await assert.rejects(d.sendJiraRelease({webhook: JIRA_HOOK, secret: 'shh', tickets: ['SF-1'], hotfixTickets: ['SF-2'], fetch: () => assert.fail('Unreleased hotfix ticket fetched')}), /Hotfix tickets must be released tickets/);
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
  assert.deepEqual(jiraOnly.jira.map(b => b.data.releaseType), ['release'], 'A release/* deploy with no hotfix PR in range is all release tickets');
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

test('released tickets: shipped PR list leaves out sync and release wrappers, reverts and reverted PRs; GraphQL and REST agree', async () => {
  const deployments = [200, [{id: 1, sha: MERGE, created_at: '2026-10-03T10:15:00Z'}, {id: 2, sha: PREV, created_at: '2026-09-26T09:00:00Z'}]];
  const fact = (number, tickets, extra = {}) => ({number, title: `Change ${number}`, author: `dev${number}`, mergedAt: '2026-01-01T00:00:00Z', tickets, ...extra});
  for (const extra of [{}, {'POST /graphql': [502, {}]}]) {
    const result = await d.releasedTickets({...deployOptions, fetch: releaseFixture({deployments, extra}).fetch});
    // #13 is a main->stage sync PR and #7 the release wrapper: in neither list.
    assert.deepEqual(result.pullRequests, [fact(10, ['SF-1', 'SF-2']), fact(14, ['SF-7']), fact(15, ['SF-10', 'SF-11'])]);
    assert.deepEqual(result.reverted, {pullRequests: [fact(11, ['SF-3'], {reason: 'reverted'}), fact(12, ['SF-3'], {title: 'Revert "Change 11"', reason: 'revert'})], tickets: ['SF-3']});
    assert.deepEqual([result.base, result.previous, result.deployedAt], [PREV, PREV, '2026-10-03T10:15:00.000Z']);
  }
  const first = await d.releasedTickets({...deployOptions, fetch: releaseFixture({deployments: [200, [{id: 1, sha: MERGE}]]}).fetch});
  assert.deepEqual([first.base, first.previous, first.deployedAt], [GAP, null, null]);
  const rollback = await d.releasedTickets({...deployOptions, fetch: releaseFixture({compare: 'behind'}).fetch});
  assert.deepEqual([rollback.base, rollback.pullRequests, rollback.reverted.pullRequests], [null, [], []]);
});

test('notification CLI: Jira release and Confluence page only for successful production, after the Jira webhook, independent of Slack', async () => {
  const {main} = await import('../scripts/notify-deployment.mjs');
  const env = {GITHUB_REPOSITORY: 'org/repo', GH_TOKEN: 'secret', DEPLOYED_SHA: MERGE, VERSION: '1.2', ENVIRONMENT: 'production', DEPLOY_STATUS: 'success', RUN_URL: deployOptions.runUrl,
    JIRA_WEBHOOK_URL: JIRA_HOOK, JIRA_WEBHOOK_SECRET: 'shh', ATLASSIAN_EMAIL: EMAIL, ATLASSIAN_API_TOKEN: TOKEN};
  const issues = Object.fromEntries(['SF-1', 'SF-2', 'SF-5', 'SF-6', 'SF-7', 'SF-10'].map(key => [key, {summary: `Summary ${key}`, type: 'Story', status: 'Dev Complete'}]));
  const setup = ({slackStatus = 200, atlassian = {}, fixture = {}} = {}) => {
    const github = releaseFixture({...fixture, extra: {'GET /releases/tags/v1.2': [404, {}], ...fixture.extra}}), fake = atlassianFake({issues, ...atlassian}), order = [];
    const fetch = async (url, init) => {
      if (url === JIRA_HOOK) { order.push('jira-webhook'); return new Response('{}'); }
      if (url.startsWith('https://hooks.slack.com/')) { order.push('slack'); return new Response('', {status: slackStatus}); }
      if (url.startsWith('https://api.atlassian.com/')) { order.push('atlassian'); return fake.fetch(url, init); }
      return github.fetch(url, init);
    };
    return {fetch, fake, order};
  };
  const now = () => new Date('2026-10-03T10:15:00Z'), quiet = {log: () => {}, warn: () => {}, now};
  const leaks = new RegExp([TOKEN, EMAIL, 'api\\.atlassian\\.com', 'SECRET'].join('|'));

  const published = setup({slackStatus: 500}), logs = [];
  await assert.rejects(main({...env, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T1/B2/S3'}, {...quiet, fetch: published.fetch, log: line => logs.push(line)}), /^Error: Slack delivery failed \(HTTP 500\)$/);
  assert.deepEqual([...new Set(published.order)], ['slack', 'jira-webhook', 'atlassian']);
  const page = published.fake.state.pages.find(item => item.title === 'repo 1.2');
  assert.deepEqual(page.labels, ['release-notes', 'repo-repo']);
  const [shipped, left] = page.body.split('<h2>Left out (reverted)</h2>');
  assert.deepEqual([...shipped.matchAll(/pull\/(\d+)">#/g)].map(m => m[1]), ['7', '10', '14', '15']);
  assert.deepEqual([...left.matchAll(/pull\/(\d+)">#/g)].map(m => m[1]), ['11', '12']);
  assert.match(shipped, /<h2>Tickets shipped \(7\)<\/h2>/);
  assert.match(shipped, /SF-11<\/a><\/td><td>Not found in Jira/);
  assert.deepEqual(published.fake.state.versions.map(v => [v.name, v.released, v.releaseDate]), [['repo 1.2', true, '2026-10-03']]);
  assert.deepEqual(Object.entries(published.fake.state.issues).filter(([, issue]) => issue.fixVersions?.length).map(([key]) => key).sort(), ['SF-1', 'SF-10', 'SF-2', 'SF-5', 'SF-6', 'SF-7']);
  assert.ok(logs.includes(`Confluence release page: https://servefirst.atlassian.net/wiki/spaces/Eng/pages/${page.id}`));
  assert.ok(logs.includes('Jira release "repo 1.2" released 2026-10-03; fix version added to 6 ticket(s), 0 already had it, 1 skipped.'));

  // No credentials: skipped with a log line, nothing sent to Atlassian.
  const absent = setup(), absentLogs = [];
  await main({...env, ATLASSIAN_EMAIL: '', ATLASSIAN_API_TOKEN: ''}, {...quiet, fetch: absent.fetch, log: line => absentLogs.push(line)});
  assert.deepEqual(absent.order, ['jira-webhook']);
  assert.ok(absentLogs.includes('Jira release and Confluence page skipped: no Atlassian credentials configured.'));
  // Half-configured credentials fail visibly before any Atlassian request; Jira is still told.
  const half = setup();
  await assert.rejects(main({...env, ATLASSIAN_API_TOKEN: ''}, {...quiet, fetch: half.fetch}), /^Error: Atlassian release not published: ATLASSIAN_API_TOKEN is required$/);
  assert.deepEqual(half.order, ['jira-webhook']);
  const lone = setup();
  await assert.rejects(main({...env, ATLASSIAN_EMAIL: '', ATLASSIAN_API_TOKEN: '', ATLASSIAN_CONFLUENCE_API_TOKEN: 'ATATT-confluence-only'}, {...quiet, fetch: lone.fetch}), /^Error: Atlassian release not published: ATLASSIAN_EMAIL must be the service account email address$/);
  assert.deepEqual(lone.order, ['jira-webhook']);
  // Staging and failed deploys never validate or call Atlassian, even with a broken configuration.
  for (const extra of [{ENVIRONMENT: 'staging'}, {DEPLOY_STATUS: 'failure', DEPLOYED_SHA: '', VERSION: ''}]) {
    const other = setup();
    await main({...env, ...extra, JIRA_WEBHOOK_URL: '', ATLASSIAN_CLOUD_ID: 'not-a-cloud', JIRA_PROJECT: 'bad key'}, {...quiet, fetch: other.fetch});
    assert.deepEqual(other.order, []);
  }
  // If the shipped tickets can't be established, neither Jira nor Atlassian gets anything.
  const blind = setup({fixture: {deployments: [403, {}]}});
  await assert.rejects(main(env, {...quiet, fetch: blind.fetch}), error => /Jira not updated: Cannot read production deployments/.test(error.message) && /Atlassian release not published: Cannot read production deployments/.test(error.message));
  assert.deepEqual(blind.order, []);
  // An Atlassian failure fails the step without stopping Jira, and leaks nothing.
  const broken = setup({atlassian: {pages: []}});
  await assert.rejects(main(env, {...quiet, fetch: broken.fetch}), error => error.message === 'Atlassian release not published: Confluence: root page "Release notes" not found in space Eng; create it first' && !leaks.test(error.message));
  assert.equal(broken.order[0], 'jira-webhook');
  const failing = setup({atlassian: {fail: {'POST wiki/api/v2/pages': 403}}});
  await assert.rejects(main(env, {...quiet, fetch: failing.fetch}), error => error.message === 'Atlassian release not published: Confluence: create repository page failed (HTTP 403)' && !leaks.test(error.message));
  // A redeploy of an already deployed commit publishes nothing (and keeps the existing page as it was).
  const redeploy = setup({fixture: {deployments: [200, [{id: 1, sha: MERGE}, {id: 3, sha: MERGE}, {id: 2, sha: PREV}]], extra: {'GET /deployments/3/statuses?per_page=100&page=1': [200, [{state: 'success'}]]}}});
  assert.equal((await main(env, {...quiet, fetch: redeploy.fetch})).atlassian.published, false);
  assert.deepEqual(redeploy.order, []);
});

test('notification CLI dry-run shows the Jira release and Confluence page it would publish without calling Atlassian', async () => {
  const {main} = await import('../scripts/notify-deployment.mjs');
  const env = {GITHUB_REPOSITORY: 'org/repo', GH_TOKEN: 'secret', DEPLOYED_SHA: MERGE, VERSION: '1.2', ENVIRONMENT: 'production', DEPLOY_STATUS: 'success', RUN_URL: deployOptions.runUrl,
    ATLASSIAN_EMAIL: EMAIL, ATLASSIAN_API_TOKEN: TOKEN, DRY_RUN: 'true'};
  const github = releaseFixture({extra: {'GET /releases/tags/v1.2': [404, {}]}}), logs = [];
  const fetch = async (url, init) => { assert.ok(url.startsWith('https://api.github.com/'), 'Dry run only reads GitHub'); return github.fetch(url, init); };
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  try {
    await main({...env, PAYLOAD_FILE: join(directory, 'p.json'), CONFLUENCE_PAGE_FILE: join(directory, 'page.html')}, {fetch, log: line => logs.push(line), warn: () => {}, now: () => new Date('2026-10-03T10:15:00Z')});
    const body = await readFile(join(directory, 'page.html'), 'utf8');
    assert.match(body, /<h2>Tickets shipped \(7\)<\/h2>/);
    assert.match(body, /Not fetched \(dry run\)/);
  } finally { await rm(directory, {recursive: true, force: true}); }
  assert.ok(logs.some(line => line.startsWith('Atlassian dry-run: would publish Confluence page "repo 1.2" (Eng › Release notes › repo release notes; labels release-notes, repo-repo) with 7 ticket(s), 3 PR(s) (0 without a ticket), 1 direct commit(s) and 2 reverted PR(s) left out.')));
  assert.ok(logs.some(line => line === 'Atlassian dry-run: would release Jira version "repo 1.2" in SF dated 2026-10-03 and add it to 7 SF ticket(s) that exist: SF-1, SF-10, SF-11, SF-2, SF-5, SF-6, SF-7.'));
});
