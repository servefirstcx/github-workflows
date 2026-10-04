import {shippedTicketKeys} from './release-notes.mjs';
const SHA = /^[a-f0-9]{40}$/;


export function outputLine(name, value) {
  requireValue(/^[a-z_][a-z0-9_]*$/.test(name) && typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value), 'Output must have a safe name and single-line value');
  return `${name}=${value}\n`;
}

export async function sendSlack({webhook, payload, fetch: fetchImpl = globalThis.fetch}) {
  if (!webhook) return {sent: false, skipped: true};
  requireValue(typeof webhook === 'string' && /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(webhook), 'Invalid Slack webhook URL');
  let response;
  try {
    response = await fetchImpl(webhook, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...payload, unfurl_links: false, unfurl_media: false})});
  } catch { throw new Error('Slack delivery failed (network, redirect or timeout)'); }
  if (!response.ok) throw new Error(`Slack delivery failed (HTTP ${response.status})`);
  // Incoming webhooks have no read-back API; report HTTP acceptance, not a
  // separately verified channel message. Never log response bodies or URLs.
  return {sent: true, skipped: false};
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

// Current incoming-webhook endpoint only. The legacy automation.atlassian.com/pro/hooks
// endpoint was retired by Atlassian on 30 May 2025, and the new one requires the secret.
const JIRA_WEBHOOK = /^https:\/\/api-private\.atlassian\.com\/automation\/webhooks\/jira\/a\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
const JIRA_BATCH = 50;
const NOTES_BLOCK = /<!-- sf-release-notes:start -->[\s\S]*?<!-- sf-release-notes:end -->/g;
const REVERTS_COMMIT = /\bThis reverts commit ([a-f0-9]{40})\b/gi;

/**
 * Jira tickets shipped by a verified production deploy, rebuilt from GitHub, not
 * from the editable notes text. Range: the previous successful production
 * deployment to the deployed commit, so a release that merged but never deployed
 * is still reported by the next one. Every commit in the range is matched to its
 * merged PR with GitHub's commit-to-PR lookup (merge, squash and rebase merges),
 * batched 100 commits per GraphQL request.
 * Ticket rule (shippedTicketKeys): branch name, or a "Closes KEY" line in the PR
 * description or a commit message. Anything touched by a revert is left out.
 * When the range cannot be established, nothing is reported (base is null).
 * Also returns the shipped PRs (no sync/release wrappers, reverts or reverted PRs)
 * and what reverts left out, for the release page.
 */
export async function releasedTickets(options) {
  const {repository, deployedSha, version, tagPrefix = 'v', mainBranch = 'main', releaseLabel = 'release', stagingBranch = 'stage'} = options;
  const api = createGitHub(options);
  requireValue(await resolveTag(api, tagName(version, tagPrefix)) === deployedSha, 'Tag does not match deployed SHA');
  const release = await associatedReleasePR(api, deployedSha, mainBranch, releaseLabel);
  requireValue(release, 'No unique merged release PR for deployed SHA');
  const {base, previous = null, deployedAt, warnings} = await reportingBase(api, deployedSha);
  if (!base) return {tickets: [], pullRequests: [], reverted: {pullRequests: [], tickets: []}, releasePr: release, base: null, previous: null, deployedAt, warnings};

  const commits = await rangeCommits(api, base, deployedSha);
  const messages = new Map(commits.map(c => [c.sha, c.commit?.message || '']));
  // Internal main<->stage sync PRs only; a fork's own main branch is an ordinary PR.
  const isSync = pr => pr.head?.repo?.full_name === repository && [mainBranch, stagingBranch].includes(pr.head?.ref) && [mainBranch, stagingBranch].includes(pr.base?.ref);
  // Release/hotfix PRs into main. A hotfix/SF-1-x branch merged into stage is an ordinary PR.
  const isRelease = pr => pr.head?.repo?.full_name === repository && pr.base?.ref === mainBranch && /^(?:release|hotfix)\//.test(pr.head?.ref || '');
  const prs = new Map(), prsOf = new Map(), releases = new Map([[release.number, release]]), releaseShas = new Map(), syncCommits = new Set();
  const associated = await associatedPullRequests(api, [...messages.keys()]);
  for (const [sha, list] of associated) {
    const found = new Set();
    for (const pr of list) {
      if (!pr?.merged_at || !messages.has(pr.merge_commit_sha) || pr.base?.repo?.full_name !== repository || !Number.isSafeInteger(pr.number)) continue;
      if (isRelease(pr)) { releases.set(pr.number, pr); releaseShas.set(pr.number, [...(releaseShas.get(pr.number) || []), sha]); continue; }
      if (isSync(pr)) { if (pr.merge_commit_sha === sha) syncCommits.add(sha); continue; }
      prs.set(pr.number, pr); found.add(pr.number);
    }
    prsOf.set(sha, found);
  }

  // Reverts, at ticket level and on the safe side: a revert never ships a ticket,
  // and every ticket on what it reverts is dropped, even if something else also
  // closes it. (A revert of a revert also drops it; mark those tickets by hand.)
  const changeKeys = sha => shippedTicketKeys({messages: [messages.get(sha)]});
  // The generated notes block never counts, for adding or for dropping tickets.
  const prKeys = pr => shippedTicketKeys({branch: pr.head?.ref, body: String(pr.body || '').replace(NOTES_BLOCK, ''),
    messages: [...prsOf].filter(([, numbers]) => numbers.has(pr.number)).map(([sha]) => messages.get(sha))});
  const isRevert = text => /^revert\b/i.test(text || '');
  const dropped = new Set(), revertPrs = new Set(), revertCommits = new Set();
  const droppedPrs = new Set();
  const dropPr = number => {
    if (droppedPrs.has(number)) return;
    droppedPrs.add(number);
    const pr = prs.get(number) || releases.get(number);
    if (pr) for (const key of prKeys(pr)) dropped.add(key);
    // A reverted hotfix takes everything it contained with it: its direct commits and the PRs merged into it.
    if (!releases.has(number) || number === release.number) return;
    for (const sha of releaseShas.get(number) || []) {
      for (const key of changeKeys(sha)) dropped.add(key);
      for (const inner of prsOf.get(sha) || []) dropPr(inner);
      for (const [other, shas] of releaseShas) if (other !== release.number && shas.includes(sha)) dropPr(other);
    }
  };
  const reverting = [...prs.values(), ...releases.values()].filter(pr => isRevert(pr.title) || /^revert-/.test(pr.head?.ref || ''));
  for (const pr of reverting) {
    revertPrs.add(pr.number);
    for (const m of String(pr.body || '').replace(NOTES_BLOCK, '').matchAll(/\bReverts\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi)) {
      if (!m[1] || m[1].toLowerCase() === repository.toLowerCase()) dropPr(Number(m[2]));
    }
  }
  for (const [sha, message] of messages) {
    const targets = [...message.matchAll(/\bThis reverts commit ([a-f0-9]{40})\b/gi)].map(m => m[1].toLowerCase());
    if (!targets.length && !isRevert(message)) continue;
    revertCommits.add(sha);
    for (const number of prsOf.get(sha)) revertPrs.add(number);
    for (const target of targets) {
      if (!messages.has(target)) continue;
      for (const key of changeKeys(target)) dropped.add(key);
      for (const number of prsOf.get(target)) dropPr(number);
      // A reverted hotfix merge, or a reverted commit inside a hotfix, drops that hotfix's tickets.
      // Every commit belongs to the release PR being deployed, so a normal release/* PR is exempt,
      // but a hotfix being deployed is not: part of its fix was undone.
      for (const pr of releases.values()) {
        const exempt = pr.number === release.number && !/^hotfix\//.test(pr.head?.ref || '');
        if (!exempt && (pr.merge_commit_sha === target || releaseShas.get(pr.number)?.includes(target))) dropPr(pr.number);
      }
    }
  }

  const keys = new Set();
  for (const pr of prs.values()) if (!revertPrs.has(pr.number)) for (const key of prKeys(pr)) keys.add(key);
  for (const sha of messages.keys()) {
    if (prsOf.get(sha).size || syncCommits.has(sha) || revertCommits.has(sha)) continue;
    for (const key of changeKeys(sha)) keys.add(key); // Direct commits, e.g. a hotfix fix commit.
  }
  // "Closes KEY" in a release/hotfix PR description, outside the generated notes block.
  for (const pr of releases.values()) {
    if (revertPrs.has(pr.number)) continue;
    for (const key of shippedTicketKeys({branch: pr.head?.ref, body: String(pr.body || '').replace(NOTES_BLOCK, '')})) keys.add(key);
  }
  const tickets = [...keys].filter(key => !dropped.has(key)).sort(), shipped = new Set(tickets);
  const facts = (list, keysOf) => list.sort((a, b) => a.number - b.number).map(pr => ({number: pr.number, title: String(pr.title || ''), author: pr.user?.login || null, mergedAt: pr.merged_at, tickets: keysOf(pr)}));
  const left = pr => revertPrs.has(pr.number) || droppedPrs.has(pr.number);
  return {tickets, releasePr: release, base, previous, deployedAt, warnings,
    pullRequests: facts([...prs.values()].filter(pr => !left(pr)), pr => prKeys(pr).filter(key => shipped.has(key))),
    reverted: {pullRequests: facts([...prs.values()].filter(left), prKeys).map(pr => ({...pr, reason: revertPrs.has(pr.number) ? 'revert' : 'reverted'})),
      tickets: [...keys].filter(key => dropped.has(key)).sort()}};
}

const GRAPHQL_BATCH = 100;
const PR_FIELDS = 'number title body mergedAt mergeCommit { oid } baseRefName baseRepository { nameWithOwner } headRefName headRepository { nameWithOwner } author { login }';

/**
 * Merged-or-not PRs containing each commit, the same list as GET /commits/{sha}/pulls,
 * but 100 commits per GraphQL request instead of one REST call each. A commit with more
 * than 100 PRs or a null PR node uses paginated REST, and so does a whole batch if the
 * GraphQL request fails. A missing commit, or REST failing too, fails closed.
 */
async function associatedPullRequests(api, shas) {
  const [owner, name] = api.repository.split('/');
  const result = new Map();
  for (let start = 0; start < shas.length; start += GRAPHQL_BATCH) {
    const batch = shas.slice(start, start + GRAPHQL_BATCH);
    const query = `query($owner: String!, $name: String!, ${batch.map((_, i) => `$c${i}: GitObjectID!`).join(', ')}) {
      repository(owner: $owner, name: $name) {
        ${batch.map((_, i) => `c${i}: object(oid: $c${i}) { ... on Commit { associatedPullRequests(first: 100) { totalCount nodes { ${PR_FIELDS} } } } }`).join('\n        ')}
      }
    }`;
    let data;
    // A failed batch (errors[], GitHub's 10s query timeout, a rate limit) is retried one commit
    // at a time over REST, which still fails closed if GitHub is really down.
    try { data = await api.graphql(query, {owner, name, ...Object.fromEntries(batch.map((sha, i) => [`c${i}`, sha]))}); }
    catch { for (const sha of batch) result.set(sha, await restPullRequests(api, sha)); continue; }
    for (const [i, sha] of batch.entries()) {
      const prs = data?.repository?.[`c${i}`]?.associatedPullRequests;
      requireValue(prs && Number.isSafeInteger(prs.totalCount) && Array.isArray(prs.nodes), 'Invalid associated pull request response');
      // More than 100 PRs, or a PR GitHub couldn't return (a null node): use the complete REST list.
      if (prs.totalCount > prs.nodes.length || prs.nodes.some(node => !node || !Number.isSafeInteger(node.number))) { result.set(sha, await restPullRequests(api, sha)); continue; }
      result.set(sha, prs.nodes.map(restShape));
    }
  }
  return result;
}

/** GraphQL PR node in the REST shape the rest of this file reads. */
function restShape(node) {
  return {number: node?.number, title: node?.title, body: node?.body, merged_at: node?.mergedAt || null,
    merge_commit_sha: node?.mergeCommit?.oid || null,
    base: {ref: node?.baseRefName, repo: {full_name: node?.baseRepository?.nameWithOwner}},
    head: {ref: node?.headRefName, repo: {full_name: node?.headRepository?.nameWithOwner}},
    user: node?.author ? {login: node.author.login} : null};
}

async function restPullRequests(api, sha) {
  const all = [];
  for (let page = 1; ; page++) {
    requireValue(page <= 10, 'Too many pull requests for one commit');
    const list = await api(`/commits/${sha}/pulls?per_page=100&page=${page}`);
    requireValue(Array.isArray(list), 'Invalid associated pull request response');
    all.push(...list);
    if (list.length < 100) return all;
  }
}

/** Previous successful production deployment. Fails closed when it can't be read. */
async function reportingBase(api, deployedSha) {
  // Newest first. Candidates start after this deploy's own record, so reruns and replays look
  // further back. Pages are read only until the answer is known.
  const deployments = [];
  let checked = 0, done = false, deployedAt = null;
  const evaluate = async deployment => {
    if (!SHA.test(deployment.sha || '') || !Number.isSafeInteger(deployment.id)) return null;
    // A newer deploy marks older ones "inactive"; any success means it reached production.
    let succeeded = false;
    for (let page = 1; !succeeded; page++) {
      requireValue(page <= 10, 'Too many deployment statuses; cannot establish the previous production deployment');
      const statuses = await api(`/deployments/${deployment.id}/statuses?per_page=100&page=${page}`);
      requireValue(Array.isArray(statuses), 'Invalid deployment statuses response');
      succeeded = statuses.some(item => item?.state === 'success');
      if (statuses.length < 100) break;
    }
    if (!succeeded) return null;
    // An earlier successful deploy of this same commit: a redeploy, its tickets were already reported.
    // (Rerunning only the notification job adds no deployment record, so that still resends.)
    if (deployment.sha === deployedSha) return {base: null, warnings: ['This commit was already deployed to production; no tickets reported. Rerun only the notification job to resend.']};
    const {status} = await api(`/compare/${deployment.sha}...${deployedSha}`);
    if (status === 'ahead') return {base: deployment.sha, previous: deployment.sha, warnings: []};
    if (status === 'behind' || status === 'identical') return {base: null, warnings: ['Deployed version is not newer than the previous production deployment (rollback or redeploy); no tickets reported.']};
    return {base: null, warnings: ['Previous production deployment is not an ancestor of this one; no tickets reported. Mark them in Jira by hand.']};
  };
  for (let page = 1; !done; page++) {
    requireValue(page <= 10, 'Too many production deployments; cannot establish the previous one');
    let list;
    try { list = await api(`/deployments?environment=production&per_page=100&page=${page}`); }
    catch (error) {
      if (error.status === 403 || error.status === 404) throw new Error('Cannot read production deployments; give the notification job deployments: read');
      throw error;
    }
    requireValue(Array.isArray(list), 'Invalid deployments response');
    deployments.push(...list);
    done = list.length < 100;
    const own = deployments.findIndex(deployment => deployment?.sha === deployedSha);
    // When GitHub recorded this deploy, so a rerun days later still dates the release correctly.
    if (own >= 0 && !deployedAt && !Number.isNaN(Date.parse(deployments[own].created_at))) deployedAt = new Date(deployments[own].created_at).toISOString();
    // Until this deploy's own record shows up, every record seen so far may be newer than it.
    if (own < 0 && !done) continue;
    for (checked = Math.max(checked, own + 1); checked < deployments.length; checked++) {
      const result = await evaluate(deployments[checked]);
      if (result) return {...result, deployedAt};
    }
  }
  // First ever recorded production deploy: report only this release PR's own changes.
  const parent = (await api(`/commits/${deployedSha}`)).parents?.[0]?.sha;
  requireValue(SHA.test(parent || ''), 'Deployed commit has no parent');
  return {base: parent, deployedAt, warnings: ['No earlier successful production deployment found; reporting this release PR only.']};
}

async function rangeCommits(api, base, head) {
  const commits = [];
  for (let page = 1; page <= 100; page++) {
    const result = await api(`/compare/${base}...${head}?per_page=100&page=${page}`);
    requireValue(Number.isSafeInteger(result.total_commits) && Array.isArray(result.commits), 'Invalid compare response');
    commits.push(...result.commits);
    if (commits.length >= result.total_commits || !result.commits.length) {
      requireValue(commits.length === result.total_commits, 'Incomplete commit range');
      return commits;
    }
  }
  throw new Error('Commit range exceeded safe limit');
}

/**
 * Posts released ticket keys to a Jira Automation incoming webhook whose trigger
 * is "Issues provided in the webhook HTTP POST body". The Jira rule owns what
 * happens next; this side holds no Jira user credential.
 */
export async function sendJiraRelease({webhook, secret, tickets = [], repository, version, notesUrl, fetch: fetchImpl = globalThis.fetch}) {
  requireValue(typeof webhook === 'string' && JIRA_WEBHOOK.test(webhook), 'Invalid Jira automation webhook URL');
  requireValue(typeof secret === 'string' && secret.length > 0 && !/[\x00-\x1f\x7f]/.test(secret), 'Jira automation webhook secret is required');
  requireValue(Array.isArray(tickets) && tickets.every(key => /^[A-Z][A-Z0-9]+-\d+$/.test(key)), 'Invalid Jira ticket keys');
  if (!tickets.length) return {sent: false, skipped: true, tickets: 0};
  const headers = {'Content-Type': 'application/json', 'X-Automation-Webhook-Token': secret};
  let sent = 0;
  for (let index = 0; index < tickets.length; index += JIRA_BATCH) {
    let response;
    try {
      response = await fetchImpl(webhook, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers,
        body: JSON.stringify({issues: tickets.slice(index, index + JIRA_BATCH), data: {repository, version, notesUrl: notesUrl || null}})});
    } catch { throw new Error(`Jira delivery failed after ${sent} of ${tickets.length} ticket(s) (network, redirect or timeout); rerun the job to resend`); }
    // Never log response bodies, URLs or the secret.
    if (!response.ok) throw new Error(`Jira delivery failed after ${sent} of ${tickets.length} ticket(s) (HTTP ${response.status}); rerun the job to resend`);
    sent += Math.min(JIRA_BATCH, tickets.length - index);
  }
  return {sent: true, skipped: false, tickets: tickets.length};
}

export function createGitHub({repository, token, fetch: fetchImpl = globalThis.fetch}) {
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repository || ''), 'GITHUB_REPOSITORY must be owner/repository');
  requireValue(typeof token === 'string' && token.length > 0, 'GH_TOKEN is required');
  const send = async (url, {method = 'GET', body, missing = false, timeout = 15000} = {}) => {
    let response;
    try {
      response = await fetchImpl(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
    } catch { throw new Error('GitHub request failed (network, redirect or timeout)'); }
    if (response.status === 404 && missing) return null;
    if (!response.ok) {
      const error = new Error(`GitHub request failed (HTTP ${response.status})`);
      error.status = response.status;
      throw error;
    }
    try { return await response.json(); } catch { throw new Error('GitHub returned invalid JSON'); }
  };
  const request = (path, options) => send(`https://api.github.com/repos/${repository}${path}`, options);
  request.repository = repository;
  /** GraphQL returns HTTP 200 with an errors array on failure; treat that as a failure too. */
  request.graphql = async (query, variables) => {
    const result = await send('https://api.github.com/graphql', {method: 'POST', body: {query, variables}, timeout: 30000});
    requireValue(!result?.errors?.length && result?.data, 'GitHub GraphQL request failed');
    return result.data;
  };
  return request;
}

export async function resolveTag(api, tag) {
  const ref = await api(`/git/ref/tags/${encodeURIComponent(tag)}`, {missing: true});
  if (!ref) return null;
  let object = ref.object;
  const seen = new Set();
  while (object?.type === 'tag') {
    requireValue(SHA.test(object.sha) && !seen.has(object.sha) && seen.size < 10, 'Invalid or cyclic annotated tag');
    seen.add(object.sha);
    object = (await api(`/git/tags/${object.sha}`)).object;
  }
  requireValue(object?.type === 'commit' && SHA.test(object.sha), 'Tag does not point to a commit');
  return object.sha;
}

function isReleasePR(pr, sha, mainBranch, releaseLabel) {
  return pr?.merged === true && pr.merge_commit_sha === sha && pr.base?.ref === mainBranch &&
    SHA.test(pr.head?.sha) && pr.labels?.some(label => label.name === releaseLabel);
}

async function trustedNotes(api, body, pr, sha) {
  const parsed = parseNotes(body);
  if (!parsed || parsed.head !== pr.head.sha) return null;
  // PR base.sha is not a frozen baseline: the base ref may advance after merge.
  // Use immutable merge first-parent ancestry, also valid for squash/rebase,
  // rather than comparing the notes baseline to today's main tip.
  const commit = await api(`/commits/${sha}`);
  const parent = commit.parents?.[0]?.sha;
  if (commit.sha !== sha || !SHA.test(parent)) return null;
  const comparison = await api(`/compare/${parsed.base}...${parent}`);
  return ['ahead', 'identical'].includes(comparison.status) ? parsed : null;
}

function tagName(version, prefix = 'v') {
  requireValue(typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version), 'VERSION must be a nonempty safe version');
  requireValue(typeof prefix === 'string' && /^[A-Za-z0-9._/-]*$/.test(prefix), 'Invalid TAG_PREFIX');
  return prefix + version;
}

async function associatedReleasePR(api, sha, mainBranch, releaseLabel) {
  const candidates = new Map();
  for (let page = 1; page <= 100; page++) {
    const pulls = await api(`/commits/${sha}/pulls?per_page=100&page=${page}`);
    requireValue(Array.isArray(pulls), 'Invalid associated pull request response');
    for (const candidate of pulls) {
      if (candidate.merge_commit_sha !== sha || !Number.isSafeInteger(candidate.number) || candidates.has(candidate.number)) continue;
      const pr = await api(`/pulls/${candidate.number}`);
      if (isReleasePR(pr, sha, mainBranch, releaseLabel)) candidates.set(pr.number, pr);
    }
    if (pulls.length < 100) return candidates.size === 1 ? [...candidates.values()][0] : null;
  }
  throw new Error('Associated pull request pagination exceeded safe limit');
}

/** Read-only resolution. No /latest lookup and no API calls on nonrelease deploys. */
export async function prepareDeployment(options) {
  const {repository, deployedSha, version, environment, status, runUrl, tagPrefix = 'v', mainBranch = 'main', releaseLabel = 'release'} = options;
  requireValue((!deployedSha && status !== 'success') || SHA.test(deployedSha), 'DEPLOYED_SHA must be a full lowercase 40-character commit SHA');
  requireValue(['production', 'staging', 'dev'].includes(environment), 'ENVIRONMENT must be production, staging or dev');
  requireValue(['success', 'failure', 'cancelled', 'skipped'].includes(status), 'Invalid DEPLOY_STATUS');
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repository || ''), 'GITHUB_REPOSITORY must be owner/repository');
  requireValue(typeof runUrl === 'string' && new RegExp(`^https://github\\.com/${repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/actions/runs/[0-9]+(?:/attempts/[0-9]+)?$`).test(runUrl), 'RUN_URL must be the exact repository workflow run URL');
  let content = '', notesAvailable = false, notesUrl;
  const warnings = [];
  if (environment === 'production' && status === 'success' && version) {
    const api = createGitHub(options);
    const tag = tagName(version, tagPrefix);
    try {
      requireValue(await resolveTag(api, tag) === deployedSha, 'Tag does not match deployed SHA');
      const pr = await associatedReleasePR(api, deployedSha, mainBranch, releaseLabel);
      requireValue(pr, 'No unique merged release PR for deployed SHA');
      const release = await api(`/releases/tags/${encodeURIComponent(tag)}`, {missing: true});
      if (release) requireValue(release.tag_name === tag && release.draft === false && release.prerelease === false, 'Release is not a published stable release');
      const saved = await trustedNotes(api, release ? release.body : pr.body, pr, deployedSha);
      requireValue(saved, 'Saved notes provenance is missing, malformed or stale');
      content = saved.content;
      notesAvailable = true;
      notesUrl = release ? `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}` : `https://github.com/${repository}/pull/${pr.number}`;
    } catch {
      content = 'Release notes unavailable for this deployment.';
      warnings.push('Release notes unavailable: exact deployed provenance could not be verified.');
    }
  }
  return {payload: buildSlackPayload({...options, content, notesUrl}), notesAvailable, notesUrl, warnings};
}

function escapeSlack(text) {
  return String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, 'ˋ').replace(/@(here|channel|everyone)\b/gi, '@\u200b$1');
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\s<>|`\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}

function proseToSlack(text) {
  // Generated Markdown escapes punctuation and HTML entities. Decode once,
  // then escape for Slack so literal '<!channel>' still cannot become a mention.
  const decoded = String(text).replace(/\\([\\`*_{}\[\]()#+!|~\-])/g, '$1')
    .replace(/&(amp|lt|gt);/g, (_, name) => ({amp: '&', lt: '<', gt: '>'})[name]);
  return escapeSlack(decoded).replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
}

/** Only explicit HTTP(S) Markdown links become Slack links; raw Slack syntax is inert. */
export function markdownToSlack(markdown) {
  let result = '', offset = 0;
  for (const match of String(markdown).matchAll(/\[([^\]\n]+)\]\(([^\s)]+)\)/g)) {
    result += proseToSlack(markdown.slice(offset, match.index));
    const url = safeUrl(match[2]);
    result += url ? `<${escapeSlack(url)}|${proseToSlack(match[1]).replace(/\|/g, '¦')}>` : proseToSlack(match[0]);
    offset = match.index + match[0].length;
  }
  return (result + proseToSlack(markdown.slice(offset))).replace(/^#{1,6} (.+)$/gm, '*$1*');
}

export function buildSlackPayload({repository, environment, status, version, runUrl, content = '', notesUrl}) {
  const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f<>`]/g, ' ').replace(/@(here|channel|everyone)\b/gi, '@\u200b$1').replace(/\s+/g, ' ').trim();
  const title = `${clean(repository)} · ${clean(environment)} · ${clean(status)}${version ? ` · ${clean(version)}` : ''}`.slice(0, 150);
  const blocks = [{type: 'header', text: {type: 'plain_text', text: title, emoji: false}}];
  const section = text => ({type: 'section', text: {type: 'mrkdwn', text, verbatim: true}});
  let chunk = '', total = 0, truncated = false;
  for (const raw of content.split('\n')) {
    const line = markdownToSlack(raw);
    // Never split a link or partially show a list item. Leave capacity for links
    // and an explicit notice, below Slack's 50-block / 40k-message ceilings.
    if (line.length > 2900 || total + line.length + 1 > 32000 || blocks.length >= 46) { truncated = true; break; }
    if (chunk.length + line.length + 1 > 2900) { blocks.push(section(chunk)); chunk = ''; }
    chunk += (chunk ? '\n' : '') + line;
    total += line.length + 1;
  }
  if (chunk) blocks.push(section(chunk));
  if (truncated) blocks.push(section('Release notes truncated — see Full release notes for the complete summary and PR/ticket list.'));
  const boundedLink = (url, label) => safeUrl(url) && escapeSlack(url).length <= 1400 ? `<${escapeSlack(url)}|${label}>` : '';
  const links = [boundedLink(notesUrl, 'Full release notes'), boundedLink(runUrl, 'Workflow run')].filter(Boolean).join(' · ');
  if (links) blocks.push(section(links));
  return {text: `${escapeSlack(title)}${links ? `\n${links}` : ''}`.slice(0, 4000), blocks, unfurl_links: false, unfurl_media: false};
}

export async function publishRelease(options) {
  const {event, version, tagPrefix = 'v', mainBranch = 'main', releaseLabel = 'release'} = options;
  const sha = event?.pull_request?.merge_commit_sha;
  requireValue(event?.action === 'closed' && SHA.test(sha) && isReleasePR(event.pull_request, sha, mainBranch, releaseLabel), 'Expected a merged release PR event');
  const api = createGitHub(options);
  const tag = tagName(version, tagPrefix);
  requireValue(await resolveTag(api, tag) === sha, 'Release tag does not match the event merge commit');
  const pr = await api(`/pulls/${event.pull_request.number}`);
  requireValue(isReleasePR(pr, sha, mainBranch, releaseLabel), 'Current release PR no longer matches the merged event');
  const parsed = await trustedNotes(api, pr.body, pr, sha);
  const warnings = parsed ? [] : ['Summary unavailable: missing, malformed or stale saved notes; publishing linked PR only.'];
  const title = String(pr.title).replace(/[\r\n\[\]<>`]/g, ' ').replace(/\\/g, '').slice(0, 250);
  const fallback = `Summary unavailable — saved release notes could not be verified.\n\n- [${title}](https://github.com/${options.repository}/pull/${pr.number})`;
  let body = parsed?.block || fallback;
  let release = await api(`/releases/tags/${encodeURIComponent(tag)}`, {missing: true});
  if (!release) {
    try {
      release = await api('/releases', {method: 'POST', body: {tag_name: tag, target_commitish: sha, name: tag, body, draft: false, prerelease: false}});
    } catch (error) {
      if (error.status !== 422) throw error;
      release = await api(`/releases/tags/${encodeURIComponent(tag)}`, {missing: true});
      if (!release) throw error;
    }
  }
  if (release.body !== body) {
    const saved = await trustedNotes(api, release.body, pr, sha);
    requireValue(saved && (!parsed || saved.base === parsed.base), 'Existing release has unverified notes; refusing to overwrite human content');
    body = release.body; // Preserve the entire existing body, including human edits.
  }
  if (release.draft !== false || release.prerelease !== false) {
    release = await api(`/releases/${release.id}`, {method: 'PATCH', body: {body, draft: false, prerelease: false}});
  }
  const verified = await api(`/releases/${release.id}`);
  requireValue(verified.body === body && verified.tag_name === tag && verified.draft === false && verified.prerelease === false, 'Release verification failed');
  return {url: verified.html_url, body: verified.body, warnings};
}

/** Return one strictly delimited notes block, or null. Never guess at broken markers. */
export function parseNotes(body = '') {
  if (typeof body !== 'string') return null;
  const markers = body.match(/<!--\s*sf-release-(?:notes|source)\b[^\n]*/g) || [];
  if (markers.length !== 3) return null;
  const match = body.match(/(?:^|\n)(<!-- sf-release-notes:start -->\n<!-- sf-release-source:([^\n]+) -->\n([\s\S]*?)\n<!-- sf-release-notes:end -->)(?=\n|$)/);
  if (!match) return null;
  try {
    // Reject duplicate JSON keys (JSON.parse alone silently takes the last).
    if (!/^\{\s*"(?:base|head)"\s*:\s*"[a-f0-9]{40}"\s*,\s*"(?:base|head)"\s*:\s*"[a-f0-9]{40}"\s*\}$/.test(match[2])) return null;
    const source = JSON.parse(match[2]);
    if (!source || Object.keys(source).sort().join(',') !== 'base,head' || !SHA.test(source.base) || !SHA.test(source.head) || !match[3].trim()) return null;
    return { ...source, content: match[3], block: match[1] };
  } catch { return null; }
}
