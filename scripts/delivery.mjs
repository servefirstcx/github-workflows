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
 * from the editable notes text. Range: the last successful production deployment
 * (so a release that merged but never deployed is still reported by the next one),
 * else the commit before the release merge. Same rule as the release notes
 * (shippedTicketKeys): branch name or "Closes KEY". Reverts and the changes they
 * revert inside the range are left out; when unsure, a ticket is not reported.
 */
export async function releasedTickets(options) {
  const {repository, deployedSha, version, tagPrefix = 'v', mainBranch = 'main', releaseLabel = 'release'} = options;
  const api = createGitHub(options);
  requireValue(await resolveTag(api, tagName(version, tagPrefix)) === deployedSha, 'Tag does not match deployed SHA');
  const release = await associatedReleasePR(api, deployedSha, mainBranch, releaseLabel);
  requireValue(release, 'No unique merged release PR for deployed SHA');
  const {base, warnings} = await reportingBase(api, deployedSha);
  if (!base) return {tickets: [], releasePr: release, warnings};

  const commits = await rangeCommits(api, base, deployedSha);
  const inRange = new Map(commits.map(c => [c.sha, c.commit?.message || '']));
  const prs = new Map(), owner = new Map(), wrappers = [release];
  for (const [sha, message] of inRange) {
    const number = Number(message.match(/^Merge pull request #(\d+) from /)?.[1] || message.split('\n')[0].match(/\(#(\d+)\)$/)?.[1]);
    if (!Number.isSafeInteger(number) || number < 1 || prs.has(number) || number === release.number) continue;
    const pr = await api(`/pulls/${number}`);
    if (pr.merged !== true || pr.merge_commit_sha !== sha || pr.base?.repo?.full_name !== repository) continue;
    if (/^(?:release|hotfix)\//.test(pr.head?.ref || '') || [mainBranch, 'stage'].includes(pr.head?.ref)) { wrappers.push(pr); continue; }
    const own = [sha];
    for (let page = 1; page <= 3; page++) { // GitHub lists at most 250 commits per PR.
      const list = await api(`/pulls/${number}/commits?per_page=100&page=${page}`);
      requireValue(Array.isArray(list), 'Invalid pull request commits response');
      own.push(...list.map(c => c.sha).filter(c => inRange.has(c)));
      if (list.length < 100) break;
    }
    for (const c of own) if (!owner.has(c)) owner.set(c, number);
    prs.set(number, {pr, own: [...new Set(own)]});
  }
  // Reverts: the revert itself never ships a ticket, and neither does what it reverts.
  const revertedShas = new Set(), revertedPrs = new Set();
  for (const message of inRange.values()) for (const m of message.matchAll(REVERTS_COMMIT)) revertedShas.add(m[1].toLowerCase());
  for (const {pr} of prs.values()) {
    if (!/^revert\b/i.test(pr.title || '') && !/^revert-/.test(pr.head?.ref || '')) continue;
    revertedPrs.add(pr.number);
    for (const m of String(pr.body || '').matchAll(/\bReverts\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi)) {
      if (!m[1] || m[1].toLowerCase() === repository.toLowerCase()) revertedPrs.add(Number(m[2]));
    }
  }
  for (const sha of revertedShas) if (owner.has(sha) && prs.get(owner.get(sha)).pr.merge_commit_sha === sha) revertedPrs.add(owner.get(sha));
  const keys = new Set();
  for (const [number, {pr, own}] of prs) {
    if (revertedPrs.has(number)) continue;
    const messages = own.filter(c => !revertedShas.has(c) && !/^Revert\b/.test(inRange.get(c))).map(c => inRange.get(c));
    for (const key of shippedTicketKeys({branch: pr.head?.ref, body: pr.body, messages})) keys.add(key);
  }
  for (const [sha, message] of inRange) {
    if (owner.has(sha) || revertedShas.has(sha) || /^Revert\b/.test(message)) continue;
    if (wrappers.some(w => w.merge_commit_sha === sha)) continue;
    for (const key of shippedTicketKeys({messages: [message]})) keys.add(key);
  }
  // "Closes KEY" written in the release or hotfix PR description itself (outside the generated notes).
  for (const wrapper of wrappers) for (const key of shippedTicketKeys({body: String(wrapper.body || '').replace(NOTES_BLOCK, '')})) keys.add(key);
  return {tickets: [...keys].sort(), releasePr: release, warnings};
}

/** Last successful production deployment before this one, if GitHub can tell us. */
async function reportingBase(api, deployedSha) {
  const fallback = async reason => {
    const parent = (await api(`/commits/${deployedSha}`)).parents?.[0]?.sha;
    requireValue(SHA.test(parent || ''), 'Deployed commit has no parent');
    return {base: parent, warnings: reason ? [reason] : []};
  };
  let deployments;
  try { deployments = await api('/deployments?environment=production&per_page=30'); }
  catch { return fallback('Could not read production deployments (grant deployments: read); reporting this release PR only.'); }
  requireValue(Array.isArray(deployments), 'Invalid deployments response');
  // Newest first. Start after this deploy's own record(s), so reruns and replays look further back.
  const own = deployments.findIndex(deployment => deployment?.sha === deployedSha);
  for (const deployment of deployments.slice(own + 1)) {
    if (deployment.sha === deployedSha || !SHA.test(deployment.sha || '') || !Number.isSafeInteger(deployment.id)) continue;
    // A newer deploy can mark older ones "inactive"; any success means it reached production.
    const statuses = await api(`/deployments/${deployment.id}/statuses?per_page=100`);
    if (!Array.isArray(statuses) || !statuses.some(item => item?.state === 'success')) continue;
    const {status} = await api(`/compare/${deployment.sha}...${deployedSha}`);
    if (status === 'ahead') return {base: deployment.sha, warnings: []};
    if (status === 'behind' || status === 'identical') return {base: null, warnings: ['Deployed version is not newer than the last production deployment; no tickets reported.']};
    return fallback('Last production deployment is not an ancestor of this one; reporting this release PR only.');
  }
  return fallback();
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
  return async function request(path, {method = 'GET', body, missing = false} = {}) {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
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
