// Node 22, no dependencies. Publishes the facts of a verified production deploy (from
// releasedTickets and Jira, never AI) to a Jira release and a Confluence page.
const SHA = /^[a-f0-9]{40}$/;
const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const ID = /^\d+$/;
const CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SITE = 'https://servefirst.atlassian.net';
const FIELDS = 'summary,issuetype,status,fixVersions';
const SEARCH_BATCH = 50;
export const DEFAULT_CLOUD_ID = '829a96bf-7cc0-4e5d-8111-ddd56ce8fc24';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** Names and page tree for one deploy. Validates configuration without any network call. */
export function releasePlan({repository, version, project = 'SF', space = 'Eng', rootTitle = 'Release notes', cloudId = DEFAULT_CLOUD_ID}) {
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repository || ''), 'GITHUB_REPOSITORY must be owner/repository');
  requireValue(typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version), 'VERSION must be a nonempty safe version');
  requireValue(/^[A-Z][A-Z0-9_]+$/.test(project || ''), 'JIRA_PROJECT must be a Jira project key');
  requireValue(/^[A-Za-z0-9]+$/.test(space || ''), 'CONFLUENCE_SPACE must be a Confluence space key');
  requireValue(typeof rootTitle === 'string' && rootTitle.trim() === rootTitle && rootTitle.length > 0 && rootTitle.length <= 255 && !/[\x00-\x1f\x7f]/.test(rootTitle), 'CONFLUENCE_ROOT_TITLE must be a single-line page title');
  requireValue(CLOUD_ID.test(cloudId || ''), 'ATLASSIAN_CLOUD_ID must be an Atlassian cloud ID (UUID)');
  const repo = repository.split('/')[1], name = `${repo} ${version}`;
  requireValue(name.length <= 255, 'Release name is too long for Jira');
  return {repository, version, project, space, rootTitle, cloudId, versionName: name, pageTitle: name, repoTitle: `${repo} release notes`,
    labels: ['release-notes', `repo-${repo.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`]};
}

/**
 * Basic auth through the api.atlassian.com gateway, so scoped API tokens work. A scoped token
 * covers one app, so Confluence can use its own token (default: the same one). Errors name
 * the step and HTTP status only: never the URL, a token or a response body.
 */
export function createAtlassian({email, token, confluenceToken = token, cloudId = DEFAULT_CLOUD_ID, fetch: fetchImpl = globalThis.fetch}) {
  const validToken = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x20\x7f]/.test(value);
  requireValue(typeof email === 'string' && /^[^\s:@]+@[^\s:@]+$/.test(email), 'ATLASSIAN_EMAIL must be the service account email address');
  requireValue(validToken(token), 'ATLASSIAN_API_TOKEN is required');
  requireValue(validToken(confluenceToken), 'ATLASSIAN_CONFLUENCE_API_TOKEN is invalid');
  requireValue(CLOUD_ID.test(cloudId || ''), 'ATLASSIAN_CLOUD_ID must be an Atlassian cloud ID (UUID)');
  const headers = secret => ({Authorization: `Basic ${Buffer.from(`${email}:${secret}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/json'});
  const send = async (step, url, {method = 'GET', body, missing = false, secret = token} = {}) => {
    let response;
    try {
      response = await fetchImpl(url, {method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: headers(secret), ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    } catch { throw new Error(`${step} failed (network, redirect or timeout)`); }
    if (response.status === 404 && missing) return null;
    if (!response.ok) {
      const error = new Error(`${step} failed (HTTP ${response.status})`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new Error(`${step} returned invalid JSON`); }
  };
  return {
    jira: (step, path, options) => send(`Jira: ${step}`, `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3${path}`, options),
    wiki: (step, path, options) => send(`Confluence: ${step}`, `https://api.atlassian.com/ex/confluence/${cloudId}/wiki${path}`, {...options, secret: confluenceToken}),
  };
}

/** Summary, type, status and fix versions per key; keys Jira doesn't return are simply absent. */
async function jiraIssues(api, keys) {
  const found = new Map();
  for (let start = 0; start < keys.length; start += SEARCH_BATCH) {
    const batch = keys.slice(start, start + SEARCH_BATCH), issues = [];
    try {
      let nextPageToken;
      for (let page = 1; ; page++) {
        requireValue(page <= 10, 'Jira: too many search result pages');
        const result = await api.jira('search issues', '/search/jql', {method: 'POST', body: {jql: `key in (${batch.map(key => `"${key}"`).join(', ')})`, fields: FIELDS.split(','), maxResults: SEARCH_BATCH, ...(nextPageToken ? {nextPageToken} : {})}});
        requireValue(Array.isArray(result?.issues), 'Jira: invalid search response');
        issues.push(...result.issues);
        if (!result.nextPageToken || result.isLast === true) break;
        nextPageToken = result.nextPageToken;
      }
    } catch (error) {
      // JQL rejects the whole query when one key doesn't exist or isn't visible: search each key on its own.
      // Same endpoint and scopes as the batch, so the token needs nothing extra; a 400 means not found.
      if (error.status !== 400) throw error;
      issues.length = 0;
      for (const key of batch) {
        try {
          const result = await api.jira('search issue', '/search/jql', {method: 'POST', body: {jql: `key in ("${key}")`, fields: FIELDS.split(','), maxResults: 1}});
          requireValue(Array.isArray(result?.issues), 'Jira: invalid search response');
          issues.push(...result.issues);
        } catch (inner) { if (inner.status !== 400) throw inner; }
      }
    }
    // A moved issue comes back under its new key; only exact keys count.
    for (const issue of issues) {
      if (!issue || !batch.includes(issue.key)) continue;
      const fields = issue.fields || {};
      found.set(issue.key, {summary: String(fields.summary ?? '').slice(0, 500), type: String(fields.issuetype?.name ?? ''), status: String(fields.status?.name ?? ''),
        fixVersions: (Array.isArray(fields.fixVersions) ? fields.fixVersions : []).map(v => String(v?.id))});
    }
  }
  return found;
}

const xml = value => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f￾￿\p{Cs}]/gu, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const link = (href, text) => `<a href="${xml(href)}">${xml(text)}</a>`;
const table = (head, rows) => `<table><tbody><tr>${head.map(cell => `<th>${xml(cell)}</th>`).join('')}</tr>${rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const day = value => Number.isNaN(Date.parse(value)) ? '' : new Date(value).toISOString().slice(0, 10);

/**
 * The version page, in Confluence storage format (XHTML). Every interpolated value is escaped,
 * and links are built only from validated parts. issues = null renders without Jira (dry run).
 */
export function renderReleasePage({plan, deployedSha, deployedAt, notesUrl, released, issues = null}) {
  const {releasePr: release, base, previous} = released;
  requireValue([deployedSha, base].every(value => SHA.test(value || '')) && (!previous || SHA.test(previous)) && Number.isSafeInteger(release?.number), 'Invalid release facts');
  const gh = `https://github.com/${plan.repository}`;
  const commit = sha => link(`${gh}/commit/${sha}`, sha.slice(0, 7));
  const pull = number => link(`${gh}/pull/${number}`, `#${number}`);
  const keys = list => list.filter(key => KEY.test(key)).map(key => link(`${SITE}/browse/${key}`, key)).join(', ');
  const details = [
    ['Repository', link(gh, plan.repository)],
    ['Version', xml(plan.version)],
    ['Deployed at (UTC)', xml(deployedAt)],
    ['Deployed commit', commit(deployedSha)],
    [/^hotfix\//.test(release.head?.ref || '') ? 'Hotfix PR' : 'Release PR', `${pull(release.number)} ${xml(release.title)}`],
    ['GitHub release', typeof notesUrl === 'string' && notesUrl.startsWith(`${gh}/`) ? link(notesUrl, notesUrl) : 'Unavailable'],
    ['Previous production commit', previous ? commit(previous) : 'None recorded (first production deploy; range is this release PR only)'],
    ['Range', link(`${gh}/compare/${base}...${deployedSha}`, `${base.slice(0, 7)}...${deployedSha.slice(0, 7)}`)],
  ];
  const issue = key => issues === null ? ['Not fetched (dry run)', '', ''] : issues.has(key) ? [issues.get(key).summary, issues.get(key).type, issues.get(key).status] : ['Not found in Jira', '', ''];
  const pr = item => [pull(item.number), xml(item.title), xml(item.author || 'unknown'), xml(day(item.mergedAt)), keys(item.tickets || [])];
  const left = released.reverted || {pullRequests: [], tickets: []};
  return [
    '<h2>Details</h2>',
    `<table><tbody>${details.map(([name, value]) => `<tr><th>${xml(name)}</th><td>${value}</td></tr>`).join('')}</tbody></table>`,
    `<h2>Tickets shipped (${released.tickets.length})</h2>`,
    released.tickets.length ? table(['Key', 'Summary', 'Type', 'Status'], released.tickets.map(key => [keys([key]), ...issue(key).map(xml)])) : '<p>No tickets.</p>',
    `<h2>Pull requests (${released.pullRequests.length})</h2>`,
    released.pullRequests.length ? table(['PR', 'Title', 'Author', 'Merged (UTC)', 'Tickets'], released.pullRequests.map(pr)) : '<p>No pull requests.</p>',
    ...(left.pullRequests.length || left.tickets.length ? ['<h2>Left out (reverted)</h2>', `<p>Tickets left out: ${left.tickets.length ? keys(left.tickets) : 'none'}</p>`,
      ...(left.pullRequests.length ? [table(['PR', 'Title', 'Author', 'Merged (UTC)', 'Tickets', 'Reason'], left.pullRequests.map(item => [...pr(item), xml(item.reason)]))] : [])] : []),
    '<p><em>Generated automatically from the production deploy. Facts only.</em></p>',
  ].join('\n');
}

function repositoryPage(plan) {
  return `<p>Production release notes for ${link(`https://github.com/${plan.repository}`, plan.repository)}, one child page per deployed version. Generated automatically from the production deploy. Facts only.</p>\n` +
    '<ac:structured-macro ac:name="children"><ac:parameter ac:name="sort">creation</ac:parameter><ac:parameter ac:name="reverse">true</ac:parameter></ac:structured-macro>';
}

const deployTime = (released, now) => (released.deployedAt && !Number.isNaN(Date.parse(released.deployedAt)) ? new Date(released.deployedAt) : now()).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** What a production deploy would publish, without any Atlassian request (DRY_RUN). */
export function previewAtlassianRelease({deployedSha, notesUrl, released, now = () => new Date(), ...config}) {
  const plan = releasePlan(config);
  if (!released.base) return {plan, lines: ['Atlassian dry-run: no new production range; nothing would be published.']};
  const deployedAt = deployTime(released, now), own = released.tickets.filter(key => key.startsWith(`${plan.project}-`));
  return {plan, body: renderReleasePage({plan, deployedSha, deployedAt, notesUrl, released}), lines: [
    `Atlassian dry-run: would publish Confluence page "${plan.pageTitle}" (${plan.space} › ${plan.rootTitle} › ${plan.repoTitle}; labels ${plan.labels.join(', ')}) with ${released.tickets.length} ticket(s), ${released.pullRequests.length} PR(s) and ${released.reverted.pullRequests.length} reverted PR(s) left out.`,
    `Atlassian dry-run: would release Jira version "${plan.versionName}" in ${plan.project} dated ${deployedAt.slice(0, 10)} and add it to ${own.length} ${plan.project} ticket(s) that exist${own.length ? `: ${own.join(', ')}` : ''}.`,
  ]};
}

/**
 * Order: Jira ticket facts, Confluence repository page, version page and labels, Jira release
 * (carrying the page URL), then fix versions. Every step looks before it creates, so a rerun
 * updates in place. Nothing is published without a new production range.
 */
export async function publishAtlassianRelease({email, token, confluenceToken, deployedSha, notesUrl, released, now = () => new Date(), fetch, ...config}) {
  const plan = releasePlan(config);
  const api = createAtlassian({email, token, confluenceToken: confluenceToken || token, cloudId: plan.cloudId, fetch});
  requireValue(SHA.test(deployedSha || ''), 'DEPLOYED_SHA must be a full lowercase 40-character commit SHA');
  requireValue(Array.isArray(released?.tickets) && released.tickets.every(key => KEY.test(key)), 'Invalid released tickets');
  if (!released.base) return {published: false, skipped: true};
  const deployedAt = deployTime(released, now), releaseDate = deployedAt.slice(0, 10);
  const issues = await jiraIssues(api, released.tickets);
  const body = renderReleasePage({plan, deployedSha, deployedAt, notesUrl, released, issues});

  const spaces = await api.wiki('read space', `/api/v2/spaces?keys=${encodeURIComponent(plan.space)}`);
  const space = (Array.isArray(spaces?.results) ? spaces.results : []).find(item => String(item?.key).toLowerCase() === plan.space.toLowerCase());
  requireValue(space && ID.test(String(space.id)), `Confluence: space ${plan.space} not found or not visible to the account`);
  const find = async (step, title) => {
    const result = await api.wiki(step, `/api/v2/pages?space-id=${space.id}&title=${encodeURIComponent(title)}&status=current&limit=250`);
    requireValue(Array.isArray(result?.results), `Confluence: ${step} returned an invalid response`);
    const pages = result.results.filter(page => page?.title === title);
    requireValue(pages.length <= 1 && pages.every(page => ID.test(String(page.id))), `Confluence: ${step} returned an ambiguous or invalid page`);
    return pages[0] || null;
  };
  // Titles are unique per space, so a page with this title elsewhere in the space is someone
  // else's: never reuse or overwrite it. Only a page under the expected parent is ours.
  const owned = (name, title, parentId, page) => {
    requireValue(String(page.parentId) === String(parentId), `Confluence: a page titled "${title}" already exists outside "${name === 'repository page' ? plan.rootTitle : plan.repoTitle}"; rename or move it, then rerun`);
    return page;
  };
  // A concurrent run may create the page first: then use that one.
  const ensure = async (name, title, parentId, value, update) => {
    let page = await find(`find ${name}`, title);
    if (!page) {
      try {
        page = await api.wiki(`create ${name}`, '/api/v2/pages', {method: 'POST', body: {spaceId: String(space.id), status: 'current', title, parentId: String(parentId), body: {representation: 'storage', value}}});
        requireValue(ID.test(String(page?.id)), `Confluence: create ${name} returned an invalid page`);
        return page;
      } catch (error) {
        if (![400, 409].includes(error.status) || !(page = await find(`find ${name}`, title))) throw error;
      }
    }
    owned(name, title, parentId, page);
    if (!update) return page;
    // A concurrent run may update it between our read and write (HTTP 409): reread and retry.
    for (let attempt = 1; ; attempt++) {
      requireValue(Number.isSafeInteger(page.version?.number), `Confluence: ${name} has no version number`);
      try {
        return await api.wiki(`update ${name}`, `/api/v2/pages/${page.id}`, {method: 'PUT', body: {id: String(page.id), status: 'current', title, body: {representation: 'storage', value}, version: {number: page.version.number + 1, message: 'Updated from the production deploy'}}});
      } catch (error) {
        if (error.status !== 409 || attempt >= 3) throw error;
      }
      page = await find(`find ${name}`, title);
      requireValue(page, `Confluence: ${name} disappeared during update`);
      owned(name, title, parentId, page);
    }
  };
  const root = await find('find root page', plan.rootTitle);
  requireValue(root, `Confluence: root page "${plan.rootTitle}" not found in space ${plan.space}; create it first`);
  const parent = await ensure('repository page', plan.repoTitle, root.id, repositoryPage(plan), false);
  const page = await ensure('version page', plan.pageTitle, parent.id, body, true);
  requireValue(ID.test(String(page?.id)), 'Confluence: update version page returned an invalid page');
  await api.wiki('add labels', `/rest/api/content/${page.id}/label`, {method: 'POST', body: plan.labels.map(name => ({prefix: 'global', name}))});
  const pageUrl = `${SITE}/wiki/spaces/${/^[A-Za-z0-9]+$/.test(space.key || '') ? space.key : plan.space}/pages/${page.id}`;

  const wanted = {released: true, releaseDate, description: `${plan.repository} ${plan.version} deployed to production on ${releaseDate}. Release notes: ${pageUrl}`};
  const named = async () => {
    const versions = await api.jira('read releases', `/project/${plan.project}/versions`);
    requireValue(Array.isArray(versions), 'Jira: invalid releases response');
    return versions.find(item => item?.name === plan.versionName) || null;
  };
  let release = await named();
  if (!release) {
    const project = await api.jira('read project', `/project/${plan.project}`);
    requireValue(ID.test(String(project?.id)), 'Jira: invalid project response');
    try { release = await api.jira('create release', '/version', {method: 'POST', body: {name: plan.versionName, projectId: Number(project.id), ...wanted}}); }
    catch (error) { if (error.status !== 400 || !(release = await named())) throw error; }
  }
  requireValue(ID.test(String(release?.id)), 'Jira: invalid release response');
  // Jira can accept edits that add an archived version and then not apply them, so never use one.
  requireValue(release.archived !== true, `Jira: release "${plan.versionName}" is archived; unarchive it in ${plan.project} › Releases, then rerun`);
  if (Object.entries(wanted).some(([field, value]) => release[field] !== value)) {
    release = await api.jira('update release', `/version/${release.id}`, {method: 'PUT', body: wanted});
    requireValue(ID.test(String(release?.id)) && release.archived !== true && release.released === true, 'Jira: update release returned an unexpected release');
  }

  const warnings = [], targets = [];
  for (const key of released.tickets) {
    if (!key.startsWith(`${plan.project}-`)) warnings.push(`${key} is not in Jira project ${plan.project}; no fix version added.`);
    else if (!issues.has(key)) warnings.push(`${key} was not found in Jira (or is not visible to the account); no fix version added.`);
    else targets.push(key);
  }
  let added = 0, already = 0;
  for (const key of targets) {
    if (issues.get(key).fixVersions.includes(String(release.id))) { already++; continue; }
    try { await api.jira(`add fix version to ${key}`, `/issue/${key}?notifyUsers=false`, {method: 'PUT', body: {update: {fixVersions: [{add: {id: String(release.id)}}]}}}); }
    catch (error) { throw new Error(`${error.message}; ${added + already} of ${targets.length} ticket(s) already have the fix version; rerun the job to retry`); }
    added++;
  }
  return {published: true, pageUrl, versionName: plan.versionName, releaseDate, fixVersions: {added, already, skipped: released.tickets.length - targets.length}, warnings};
}
