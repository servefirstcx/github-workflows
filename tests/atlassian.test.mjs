import test from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../scripts/atlassian.mjs';
import {atlassianFake, CLOUD, EMAIL, TOKEN, WIKI_TOKEN} from './atlassian-fixture.mjs';

const DEPLOYED = 'c'.repeat(40), PREV = 'd'.repeat(40);
const released = (extra = {}) => ({
  tickets: ['OPS-4', 'SF-1', 'SF-2', 'SF-404'],
  pullRequests: [
    {number: 10, title: 'Export grid images', author: 'dev10', mergedAt: '2026-09-30T09:00:00Z', tickets: ['SF-1']},
    {number: 14, title: 'CSAT SMS step 1', author: null, mergedAt: '2026-10-01T09:00:00Z', tickets: ['OPS-4', 'SF-2']},
  ],
  reverted: {pullRequests: [
    {number: 11, title: 'Change 11', author: 'dev11', mergedAt: '2026-09-29T09:00:00Z', tickets: ['SF-3'], reason: 'reverted'},
    {number: 12, title: 'Revert "Change 11"', author: 'dev12', mergedAt: '2026-09-30T10:00:00Z', tickets: ['SF-3'], reason: 'revert'},
  ], tickets: ['SF-3']},
  releasePr: {number: 7, title: 'Release 4.26.0', head: {ref: 'release/4.26.0'}},
  base: PREV, previous: PREV, deployedAt: '2026-10-03T10:15:00.000Z', warnings: [], ...extra});
const issues = () => ({
  'SF-1': {summary: 'Grid images lost', type: 'Bug', status: 'Dev Complete'},
  'SF-2': {summary: 'SMS step', type: 'Story', status: 'Done (In Production)'},
  'OPS-4': {summary: 'Rotate keys', type: 'Task', status: 'Done'},
});
const options = (fake, extra = {}) => ({email: EMAIL, token: TOKEN, repository: 'servefirstcx/sf-api', version: '4.26.0', deployedSha: DEPLOYED,
  notesUrl: 'https://github.com/servefirstcx/sf-api/releases/tag/v4.26.0', released: released(), fetch: fake.fetch, now: () => assert.fail('Uses the deployment time'), ...extra});
const page = (fake, title) => fake.state.pages.find(item => item.title === title);

test('first publish creates repository page, version page, labels, released Jira version and SF fix versions, in order', async () => {
  const fake = atlassianFake({issues: issues()});
  const result = await a.publishAtlassianRelease(options(fake));
  const index = page(fake, 'sf-api release notes'), version = page(fake, 'sf-api 4.26.0'), [release] = fake.state.versions;
  assert.equal(index.parentId, '1');
  assert.match(index.body, /ac:name="children"/);
  assert.equal(version.parentId, index.id);
  assert.deepEqual(version.labels, ['release-notes', 'repo-sf-api']);
  assert.equal(result.pageUrl, `https://servefirst.atlassian.net/wiki/spaces/Eng/pages/${version.id}`);
  assert.equal(result.versionName, 'sf-api 4.26.0');
  assert.deepEqual(release, {id: release.id, name: 'sf-api 4.26.0', projectId: 10000, released: true, releaseDate: '2026-10-03',
    description: `servefirstcx/sf-api 4.26.0 deployed to production on 2026-10-03. Release notes: ${result.pageUrl}`});
  // Fix version only on SF tickets that exist: not OPS-4 (other project), not SF-404 (missing).
  assert.deepEqual(fake.state.issues['SF-1'].fixVersions, [release.id]);
  assert.deepEqual(fake.state.issues['SF-2'].fixVersions, [release.id]);
  assert.equal(fake.state.issues['OPS-4'].fixVersions, undefined);
  assert.deepEqual(result.fixVersions, {added: 2, already: 0, skipped: 2});
  assert.deepEqual(result.warnings, ['OPS-4 is not in Jira project SF; no fix version added.', 'SF-404 was not found in Jira (or is not visible to the account); no fix version added.']);
  assert.equal(fake.calls[0].key, 'POST jira/search/jql');
  assert.equal(fake.calls.filter(call => call.key === 'POST jira/search/jql').length, 1);
  assert.deepEqual(fake.writes(), ['POST wiki/api/v2/pages', 'POST wiki/api/v2/pages', 'POST wiki/rest/api/content/N/label',
    'POST jira/version', 'PUT jira/version/N', 'PUT jira/issue/SF-1?notifyUsers=false', 'PUT jira/issue/SF-2?notifyUsers=false']);
  for (const fact of ['<a href="https://github.com/servefirstcx/sf-api/commit/' + DEPLOYED + '">ccccccc</a>', '2026-10-03T10:15:00Z',
    '<a href="https://github.com/servefirstcx/sf-api/pull/7">#7</a> Release 4.26.0', '<a href="https://github.com/servefirstcx/sf-api/releases/tag/v4.26.0">',
    '<a href="https://github.com/servefirstcx/sf-api/commit/' + PREV + '">ddddddd</a>', `compare/${PREV}...${DEPLOYED}`,
    '<td><a href="https://servefirst.atlassian.net/browse/SF-1">SF-1</a></td><td>Grid images lost</td><td>Bug</td>',
    '<td><a href="https://servefirst.atlassian.net/browse/SF-404">SF-404</a></td><td>Not found in Jira</td>',
    '<td>CSAT SMS step 1</td><td>unknown</td><td>2026-10-01</td>', '<h2>Left out (reverted)</h2>', '<td>revert</td>', '<td>reverted</td>',
    'Generated automatically from the production deploy. Facts only.']) assert.ok(version.body.includes(fact), fact);
});

test('rerun updates the same page and release in place: no duplicates and no repeated issue edits', async () => {
  const fake = atlassianFake({issues: issues()});
  const first = await a.publishAtlassianRelease(options(fake));
  const from = fake.calls.length;
  const second = await a.publishAtlassianRelease(options(fake));
  assert.deepEqual(fake.writes(from), ['PUT wiki/api/v2/pages/N', 'POST wiki/rest/api/content/N/label']);
  assert.equal(fake.state.pages.length, 3);
  assert.equal(fake.state.versions.length, 1);
  assert.equal(page(fake, 'sf-api 4.26.0').version.number, 2);
  assert.deepEqual(page(fake, 'sf-api 4.26.0').labels, ['release-notes', 'repo-sf-api']);
  assert.equal(second.pageUrl, first.pageUrl);
  assert.deepEqual(second.fixVersions, {added: 0, already: 2, skipped: 2});
});

test('existing pages and an unreleased version are updated, and only tickets missing the fix version are edited', async () => {
  const fake = atlassianFake({issues: {...issues(), 'SF-1': {...issues()['SF-1'], fixVersions: ['77']}},
    pages: [{id: '1', title: 'Release notes', parentId: null}, {id: '2', title: 'sf-api release notes', parentId: '1', body: 'Human intro'}, {id: '3', title: 'sf-api 4.26.0', parentId: '2', version: {number: 4}, labels: ['release-notes']}],
    versions: [{id: '77', name: 'sf-api 4.26.0', released: false, description: 'old'}, {id: '78', name: 'sf-api 4.25.0', released: true}]});
  const result = await a.publishAtlassianRelease(options(fake));
  assert.deepEqual(fake.writes(), ['PUT wiki/api/v2/pages/3', 'POST wiki/rest/api/content/3/label', 'PUT jira/version/77', 'PUT jira/issue/SF-2?notifyUsers=false']);
  assert.equal(page(fake, 'sf-api release notes').body, 'Human intro');
  assert.equal(page(fake, 'sf-api 4.26.0').version.number, 5);
  assert.deepEqual(page(fake, 'sf-api 4.26.0').labels, ['release-notes', 'repo-sf-api']);
  assert.equal(fake.state.versions[0].released, true);
  assert.deepEqual(result.fixVersions, {added: 1, already: 1, skipped: 2});
  assert.equal(result.pageUrl, 'https://servefirst.atlassian.net/wiki/spaces/Eng/pages/3');
});

test('a separate Confluence token is sent only to Confluence (scoped tokens cover one app)', async () => {
  const fake = atlassianFake({issues: issues(), wikiToken: WIKI_TOKEN});
  await a.publishAtlassianRelease(options(fake, {confluenceToken: WIKI_TOKEN}));
  // The fake checks each request's token per product; the shared token is refused by its Confluence side.
  assert.ok(fake.calls.some(call => call.key.startsWith('PUT jira/')) && fake.calls.some(call => call.key.startsWith('POST wiki/')));
  await assert.rejects(a.publishAtlassianRelease(options(atlassianFake({issues: issues(), wikiToken: WIKI_TOKEN}))), /^Error: Confluence: read space failed/);
});

test('a concurrent run that creates the pages or version first is reused, not duplicated', async () => {
  const fake = atlassianFake({issues: issues(), race: true});
  await a.publishAtlassianRelease(options(fake));
  assert.equal(fake.state.pages.length, 3);
  assert.equal(fake.state.versions.length, 1);
  assert.match(page(fake, 'sf-api 4.26.0').body, /Tickets shipped/);
  assert.equal(fake.state.versions[0].released, true);
});

test('a same-title page outside the release tree is never reused or overwritten', async () => {
  const human = {id: '9', title: 'Team pages', parentId: null};
  for (const misplaced of [{id: '3', title: 'sf-api 4.26.0', parentId: '9', body: 'Human notes'}, {id: '2', title: 'sf-api release notes', parentId: '9', body: 'Human notes'}]) {
    const fake = atlassianFake({issues: issues(), pages: [{id: '1', title: 'Release notes', parentId: null}, human, ...(misplaced.id === '3' ? [{id: '2', title: 'sf-api release notes', parentId: '1'}] : []), misplaced]});
    await assert.rejects(a.publishAtlassianRelease(options(fake)), new RegExp(`^Error: Confluence: a page titled "${misplaced.title}" already exists outside "${misplaced.id === '3' ? 'sf-api release notes' : 'Release notes'}"; rename or move it, then rerun$`));
    assert.deepEqual(fake.writes(), []);
    assert.equal(fake.state.pages.find(item => item.id === misplaced.id).body, 'Human notes');
    assert.equal(fake.state.versions.length, 0);
  }
  // Also when a concurrent create puts the page somewhere else.
  const raced = atlassianFake({issues: issues(), race: true, raceParent: '9', pages: [{id: '1', title: 'Release notes', parentId: null}, human]});
  await assert.rejects(a.publishAtlassianRelease(options(raced)), /^Error: Confluence: a page titled "sf-api release notes" already exists outside "Release notes"/);
  assert.deepEqual(raced.writes(), ['POST wiki/api/v2/pages']);
});

test('an archived Jira release is refused before any ticket is edited', async () => {
  const fake = atlassianFake({issues: issues(), versions: [{id: '77', name: 'sf-api 4.26.0', released: true, archived: true, releaseDate: '2026-10-03'}]});
  await assert.rejects(a.publishAtlassianRelease(options(fake)), /^Error: Jira: release "sf-api 4.26.0" is archived; unarchive it in SF › Releases, then rerun$/);
  assert.ok(!fake.writes().some(call => call.startsWith('PUT jira/')));
  assert.ok(Object.values(fake.state.issues).every(issue => !issue.fixVersions?.length));
  // The update must come back released and unarchived (or silent on those fields) before tickets are edited.
  for (const reply of [{archived: true}, {released: false}, {id: 'x'}]) {
    const odd = atlassianFake({issues: issues(), versions: [{id: '77', name: 'sf-api 4.26.0', released: false}]});
    const {fetch} = odd;
    const wrapped = async (url, init) => /\/version\/77$/.test(url) && init.method === 'PUT'
      ? (await fetch(url, init), new Response(JSON.stringify({id: '77', name: 'sf-api 4.26.0', released: true, ...reply}), {status: 200})) : fetch(url, init);
    await assert.rejects(a.publishAtlassianRelease(options(odd, {fetch: wrapped})), /^Error: Jira: update release returned an unexpected release$/);
    assert.ok(!odd.writes().some(call => call.startsWith('PUT jira/issue/')));
  }
  const terse = atlassianFake({issues: issues(), versions: [{id: '77', name: 'sf-api 4.26.0', released: false}]});
  const terseFetch = async (url, init) => /\/version\/77$/.test(url) && init.method === 'PUT'
    ? (await terse.fetch(url, init), new Response(JSON.stringify({id: '77'}), {status: 200})) : terse.fetch(url, init);
  assert.equal((await a.publishAtlassianRelease(options(terse, {fetch: terseFetch}))).fixVersions.added, 2);
});

test('a page updated by another run between read and write is reread and retried, within a limit', async () => {
  let bumps = 1;
  const fake = atlassianFake({issues: issues(), beforeUpdate: item => { if (item.title === 'sf-api 4.26.0' && bumps-- > 0) item.version.number++; }});
  await a.publishAtlassianRelease(options(fake));
  bumps = 1;
  const result = await a.publishAtlassianRelease(options(fake));
  assert.equal(page(fake, 'sf-api 4.26.0').version.number, 3);
  assert.match(page(fake, 'sf-api 4.26.0').body, /Tickets shipped/);
  assert.deepEqual(result.fixVersions, {added: 0, already: 2, skipped: 2});
  // Two real publishers sharing one site both succeed.
  const shared = atlassianFake({issues: issues()});
  await a.publishAtlassianRelease(options(shared));
  const outcomes = await Promise.allSettled([a.publishAtlassianRelease(options(shared)), a.publishAtlassianRelease(options(shared))]);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['fulfilled', 'fulfilled']);
  assert.equal(page(shared, 'sf-api 4.26.0').version.number, 3);
  // A page moved out of the tree while we retry is not overwritten.
  let moved = false;
  const moving = atlassianFake({issues: issues(), pages: [{id: '1', title: 'Release notes', parentId: null}, {id: '9', title: 'Team pages', parentId: null}],
    beforeUpdate: item => { if (item.title === 'sf-api 4.26.0' && moving.state.versions.length && !moved) { moved = true; item.version.number++; item.parentId = '9'; item.body = 'Human notes'; } }});
  await a.publishAtlassianRelease(options(moving));
  await assert.rejects(a.publishAtlassianRelease(options(moving)), /^Error: Confluence: a page titled "sf-api 4.26.0" already exists outside "sf-api release notes"/);
  assert.equal(page(moving, 'sf-api 4.26.0').body, 'Human notes');
  // A page that keeps changing still fails visibly after three tries.
  const busy = atlassianFake({issues: issues(), beforeUpdate: item => { if (item.title === 'sf-api 4.26.0') item.version.number++; }});
  await a.publishAtlassianRelease(options(busy)).catch(() => {});
  const before = busy.calls.length;
  await assert.rejects(a.publishAtlassianRelease(options(busy)), /^Error: Confluence: update version page failed \(HTTP 409\)$/);
  assert.equal(busy.calls.slice(before).filter(call => call.key.startsWith('PUT wiki/')).length, 3);
});

test('a key Jira search rejects falls back to one search per key (no extra token scopes) with the same result', async () => {
  const strict = atlassianFake({issues: issues(), strictJql: true}), lenient = atlassianFake({issues: issues()});
  const result = await a.publishAtlassianRelease(options(strict));
  await a.publishAtlassianRelease(options(lenient));
  assert.ok(strict.calls.some(call => call.key === 'POST jira/search/jql' && call.body?.jql === 'key in ("SF-404")'));
  assert.ok(!strict.calls.some(call => call.key.startsWith('GET jira/issue/')), 'GET /issue needs scopes the token lacks');
  assert.equal(page(strict, 'sf-api 4.26.0').body, page(lenient, 'sf-api 4.26.0').body);
  assert.deepEqual(result.fixVersions, {added: 2, already: 0, skipped: 2});
});

test('hostile titles, summaries and authors are escaped; only expected storage-format tags appear', async () => {
  const hostile = '<script>alert(1)</script> & "q" \'s\' ]]><ac:structured-macro ac:name="html"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro>\u0000\u0007';
  const fake = atlassianFake({issues: {...issues(), 'SF-1': {summary: `<img src=x onerror=alert(1)> ${hostile}`, type: '<b>Bug</b>', status: '"Done"'}}});
  const facts = released({releasePr: {number: 7, title: hostile, head: {ref: 'hotfix/4.26.1'}},
    pullRequests: [{number: 10, title: hostile, author: '<u>me</u>', mergedAt: 'not a date', tickets: ['SF-1', '"><script>']}]});
  await a.publishAtlassianRelease(options(fake, {released: facts, notesUrl: 'javascript:alert(1)'}));
  const body = page(fake, 'sf-api 4.26.0').body;
  assert.deepEqual([...new Set([...body.matchAll(/<\/?([A-Za-z0-9:-]+)/g)].map(m => m[1]))].sort(), ['a', 'em', 'h2', 'p', 'table', 'tbody', 'td', 'th', 'tr']);
  assert.doesNotMatch(body, /<script|<img|<b>|<u>|<ac:|javascript:|[\x00-\x08]/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;q&quot; &#39;s&#39; \]\]&gt;&lt;ac:structured-macro/);
  assert.match(body, /<th>Hotfix PR<\/th>/);
  assert.match(body, /<th>GitHub release<\/th><td>Unavailable<\/td>/);
});

test('a missing root page fails clearly before any write', async () => {
  const fake = atlassianFake({issues: issues(), pages: []});
  await assert.rejects(a.publishAtlassianRelease(options(fake)), /^Error: Confluence: root page "Release notes" not found in space Eng; create it first$/);
  assert.deepEqual(fake.writes(), []);
});

test('Atlassian errors name the step and never leak the token, email, URL or response body', async () => {
  const leaks = new RegExp([TOKEN, EMAIL, CLOUD, 'api\\.atlassian\\.com', 'SECRET', Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')].join('|'));
  for (const [fail, message] of [
    [{'POST jira/search/jql': 401}, 'Jira: search issues failed (HTTP 401)'],
    [{'GET wiki/api/v2/spaces': 403}, 'Confluence: read space failed (HTTP 403)'],
    [{'POST wiki/api/v2/pages': 500}, 'Confluence: create repository page failed (HTTP 500)'],
    [{'POST wiki/rest/api/content': 403}, 'Confluence: add labels failed (HTTP 403)'],
    [{'POST jira/version': 403}, 'Jira: create release failed (HTTP 403)'],
    [{'PUT jira/issue/SF-2': 400}, 'Jira: add fix version to SF-2 failed (HTTP 400); 1 of 2 ticket(s) already have the fix version; rerun the job to retry'],
  ]) {
    const fake = atlassianFake({issues: issues(), fail});
    await assert.rejects(a.publishAtlassianRelease(options(fake)), error => error.message === message && !leaks.test(error.message), message);
  }
  const thrown = async url => { throw new Error(`${url} ${TOKEN}`); };
  await assert.rejects(a.publishAtlassianRelease(options({fetch: thrown})), error => error.message === 'Jira: search issues failed (network, redirect or timeout)');
});

test('invalid configuration fails before any request; no new production range publishes nothing', async () => {
  const none = {fetch: () => assert.fail('No Atlassian request')};
  for (const [extra, pattern] of [[{cloudId: 'servefirst'}, /ATLASSIAN_CLOUD_ID/], [{project: 'sf'}, /JIRA_PROJECT/], [{space: 'Eng space'}, /CONFLUENCE_SPACE/],
    [{rootTitle: 'Release\nnotes'}, /CONFLUENCE_ROOT_TITLE/], [{token: ''}, /ATLASSIAN_API_TOKEN/], [{email: 'bot'}, /ATLASSIAN_EMAIL/], [{version: '1.0\n'}, /VERSION/]]) {
    await assert.rejects(a.publishAtlassianRelease(options(none, extra)), pattern);
  }
  assert.deepEqual(await a.publishAtlassianRelease(options(none, {released: released({base: null, previous: null, tickets: []})})), {published: false, skipped: true});
});

test('preview renders the page and plan without any request', () => {
  const preview = a.previewAtlassianRelease({repository: 'servefirstcx/sf-api', version: '4.26.0', deployedSha: DEPLOYED, released: released({previous: null})});
  assert.match(preview.lines.join('\n'), /"sf-api 4\.26\.0" \(Eng › Release notes › sf-api release notes; labels release-notes, repo-sf-api\) with 4 ticket\(s\), 2 PR\(s\)/);
  assert.match(preview.lines.join('\n'), /Jira version "sf-api 4\.26\.0" in SF dated 2026-10-03 and add it to 3 SF ticket\(s\) that exist: SF-1, SF-2, SF-404/);
  assert.match(preview.body, /Not fetched \(dry run\)/);
  assert.match(preview.body, /None recorded \(first production deploy/);
});
