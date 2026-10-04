// In-memory Jira + Confluence behind the api.atlassian.com gateway, for tests only (not a *.test.mjs file).
// Unknown requests, wrong auth or a missing timeout/redirect guard fail the test instead of being answered.
import assert from 'node:assert/strict';

export const CLOUD = '829a96bf-7cc0-4e5d-8111-ddd56ce8fc24';
export const EMAIL = 'release-bot@servefirst.co.uk', TOKEN = 'ATATT-scoped-SECRET-token', WIKI_TOKEN = 'ATATT-confluence-SECRET-token';
const JIRA = `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3`, WIKI = `https://api.atlassian.com/ex/confluence/${CLOUD}/wiki`;

/**
 * pages: existing Confluence pages ({id, title, parentId}); versions: existing SF versions;
 * issues: {KEY: {summary, type, status, fixVersions}}. strictJql: a missing key fails the whole
 * search with 400, as Jira's JQL validation does. race: the first create of each page/version
 * loses to a concurrent run (the object appears, the request gets 400). fail: {'METHOD path-prefix': status}.
 * wikiToken: the token Confluence requests must carry (scoped tokens cover one app).
 */
export function atlassianFake({pages = [{id: '1', title: 'Release notes', parentId: null}], versions = [], issues = {}, strictJql = false, race = false, fail = {}, wikiToken = TOKEN} = {}) {
  const state = {pages: pages.map(page => ({spaceId: '100', status: 'current', version: {number: 1}, labels: [], body: '', ...page})),
    versions: versions.map(version => ({projectId: 10000, ...version})), issues: structuredClone(issues)};
  const calls = [], raced = new Set();
  let nextId = 5000;
  const issueJson = key => ({id: String(nextId++), key, fields: {summary: state.issues[key].summary, issuetype: {name: state.issues[key].type}, status: {name: state.issues[key].status},
    fixVersions: (state.issues[key].fixVersions || []).map(id => ({id, name: state.versions.find(v => v.id === id)?.name}))}});
  const handle = (key, body) => {
    let m;
    if (key === 'GET wiki/api/v2/spaces?keys=Eng') return {results: [{id: '100', key: 'Eng', name: 'Engineering'}]};
    if ((m = key.match(/^GET wiki\/api\/v2\/pages\?space-id=100&title=([^&]+)&status=current&limit=250$/))) {
      const title = decodeURIComponent(m[1]);
      return {results: state.pages.filter(page => page.title === title).map(({labels, body, ...page}) => page), _links: {}};
    }
    if (key === 'POST wiki/api/v2/pages') {
      assert.deepEqual(Object.keys(body).sort(), ['body', 'parentId', 'spaceId', 'status', 'title']);
      assert.equal(body.spaceId, '100'); assert.equal(body.status, 'current'); assert.equal(body.body.representation, 'storage');
      assert.ok(state.pages.some(page => page.id === body.parentId), 'Parent page must exist');
      const page = {id: String(nextId++), title: body.title, parentId: body.parentId, spaceId: '100', status: 'current', version: {number: 1}, labels: [], body: body.body.value};
      if (race && !raced.has(body.title)) { raced.add(body.title); state.pages.push({...page, body: 'created by a concurrent run'}); return [400, {message: 'A page with this title already exists'}]; }
      if (state.pages.some(existing => existing.title === body.title)) return [400, {message: 'A page with this title already exists'}];
      state.pages.push(page);
      return {...page, labels: undefined, body: undefined};
    }
    if ((m = key.match(/^PUT wiki\/api\/v2\/pages\/(\d+)$/))) {
      const page = state.pages.find(item => item.id === m[1]);
      assert.ok(page, 'Updating a missing page');
      assert.deepEqual(Object.keys(body).sort(), ['body', 'id', 'status', 'title', 'version']);
      assert.equal(body.id, page.id); assert.equal(body.body.representation, 'storage');
      if (body.version.number !== page.version.number + 1) return [409, {message: 'Version conflict'}];
      Object.assign(page, {title: body.title, body: body.body.value, version: {number: body.version.number}});
      return {id: page.id, title: page.title, version: page.version};
    }
    if ((m = key.match(/^POST wiki\/rest\/api\/content\/(\d+)\/label$/))) {
      const page = state.pages.find(item => item.id === m[1]);
      assert.ok(page && Array.isArray(body) && body.every(label => label.prefix === 'global' && /^[a-z0-9_-]+$/.test(label.name)));
      for (const {name} of body) if (!page.labels.includes(name)) page.labels.push(name);
      return {results: page.labels.map(name => ({prefix: 'global', name}))};
    }
    if (key === 'GET jira/project/SF') return {id: '10000', key: 'SF'};
    if (key === 'GET jira/project/SF/versions') return state.versions;
    if (key === 'POST jira/version') {
      assert.equal(body.projectId, 10000);
      // Jira documents `released` as not applicable on create; this fake ignores it so the follow-up update is exercised.
      const version = {id: String(nextId++), name: body.name, projectId: 10000, released: false, releaseDate: body.releaseDate, description: body.description};
      if (race && !raced.has(body.name)) { raced.add(body.name); state.versions.push(version); return [400, {errors: {name: 'A version with this name already exists in this project.'}}]; }
      if (state.versions.some(existing => existing.name === body.name)) return [400, {errors: {name: 'A version with this name already exists in this project.'}}];
      state.versions.push(version);
      return version;
    }
    if ((m = key.match(/^PUT jira\/version\/(\d+)$/))) {
      const version = state.versions.find(item => item.id === m[1]);
      assert.ok(version, 'Updating a missing version');
      return Object.assign(version, body);
    }
    if (key === 'POST jira/search/jql') {
      assert.deepEqual(body.fields, ['summary', 'issuetype', 'status', 'fixVersions']);
      const match = body.jql.match(/^key in \(((?:"[A-Z][A-Z0-9]+-\d+"(?:, )?)+)\)$/);
      assert.ok(match, `Unexpected JQL ${body.jql}`);
      const keys = match[1].split(', ').map(key => key.slice(1, -1));
      assert.ok(keys.length <= body.maxResults);
      if (strictJql && keys.some(key => !state.issues[key])) return [400, {errorMessages: ["An issue with key 'X' does not exist for field 'key'."]}];
      return {issues: keys.filter(key => state.issues[key]).map(issueJson), isLast: true};
    }
    if ((m = key.match(/^PUT jira\/issue\/([A-Z][A-Z0-9]+-\d+)\?notifyUsers=false$/))) {
      const issue = state.issues[m[1]];
      if (!issue) return [404, {}];
      assert.equal(body.update.fixVersions.length, 1);
      assert.deepEqual(Object.keys(body), ['update']); assert.deepEqual(Object.keys(body.update), ['fixVersions']);
      const {id} = body.update.fixVersions[0].add;
      assert.ok(state.versions.some(version => version.id === id), 'Fix version must exist');
      issue.fixVersions = [...new Set([...(issue.fixVersions || []), id])];
      return [204, null];
    }
    assert.fail(`Unexpected Atlassian request ${key}`);
  };
  const fetch = async (url, init = {}) => {
    assert.ok(url.startsWith(`${JIRA}/`) || url.startsWith(`${WIKI}/`), `Request outside the Atlassian gateway: ${url}`);
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${EMAIL}:${url.startsWith(WIKI) ? wikiToken : TOKEN}`).toString('base64')}`);
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    const key = `${init.method || 'GET'} ${url.replace(`${JIRA}/`, 'jira/').replace(`${WIKI}/`, 'wiki/')}`;
    const body = init.body && JSON.parse(init.body);
    calls.push({key, body});
    const failing = Object.entries(fail).find(([prefix]) => key.startsWith(prefix));
    if (failing) return new Response(`{"message":"SECRET server detail for ${EMAIL}"}`, {status: failing[1]});
    const value = handle(key, body);
    const [status, data] = Array.isArray(value) && typeof value[0] === 'number' ? value : [200, value];
    return new Response(status === 204 ? null : JSON.stringify(data), {status});
  };
  // Write requests since call index `from`, with generated IDs normalised to N.
  const writes = (from = 0) => calls.slice(from).filter(call => !call.key.startsWith('GET ') && call.key !== 'POST jira/search/jql').map(call => call.key.replace(/\b\d{4,}\b/g, 'N'));
  return {fetch, calls, state, writes};
}
