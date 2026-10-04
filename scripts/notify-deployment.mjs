#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {prepareDeployment, releasedTickets, sendJiraRelease, sendSlack} from './delivery.mjs';
import {DEFAULT_CLOUD_ID, previewAtlassianRelease, publishAtlassianRelease} from './atlassian.mjs';

export async function main(env = process.env, {fetch = globalThis.fetch, log = console.log, warn = console.warn, now} = {}) {
  if (env.DRY_RUN && !['true', 'false'].includes(env.DRY_RUN)) throw new Error('DRY_RUN must be true or false');
  const dryRun = env.DRY_RUN === 'true';
  const atlassianConfigured = Boolean(env.ATLASSIAN_EMAIL || env.ATLASSIAN_API_TOKEN);
  if (!env.SLACK_WEBHOOK_URL && !env.JIRA_WEBHOOK_URL && !atlassianConfigured && !dryRun) {
    log('Deployment notification skipped: no optional Slack, Jira or Atlassian configuration.');
    return {sent: false, skipped: true};
  }
  const result = await prepareDeployment({repository: env.GITHUB_REPOSITORY, token: env.GH_TOKEN, deployedSha: env.DEPLOYED_SHA, version: env.VERSION, environment: env.ENVIRONMENT, status: env.DEPLOY_STATUS, runUrl: env.RUN_URL, tagPrefix: env.TAG_PREFIX ?? 'v', mainBranch: env.MAIN_BRANCH || 'main', releaseLabel: env.RELEASE_LABEL || 'release', fetch});
  for (const warning of result.warnings) warn(`Warning: ${warning}`);
  if (dryRun || env.PAYLOAD_FILE) await writeFile(env.PAYLOAD_FILE || 'deployment-slack-payload.json', JSON.stringify(result.payload, null, 2) + '\n', {mode: 0o600});
  // Jira and Atlassian only ever hear about successful production deploys; nothing else is validated or sent.
  const production = env.ENVIRONMENT === 'production' && env.DEPLOY_STATUS === 'success';
  const jiraEligible = Boolean(env.JIRA_WEBHOOK_URL) && production;
  const atlassianEligible = atlassianConfigured && production;
  if (production && !atlassianConfigured) log('Jira release and Confluence page skipped: no Atlassian credentials configured.');
  const jiraOptions = {repository: env.GITHUB_REPOSITORY, token: env.GH_TOKEN, deployedSha: env.DEPLOYED_SHA, version: env.VERSION, tagPrefix: env.TAG_PREFIX ?? 'v', mainBranch: env.MAIN_BRANCH || 'main', releaseLabel: env.RELEASE_LABEL || 'release', fetch};
  const atlassianOptions = {email: env.ATLASSIAN_EMAIL, token: env.ATLASSIAN_API_TOKEN, confluenceToken: env.ATLASSIAN_CONFLUENCE_API_TOKEN, cloudId: env.ATLASSIAN_CLOUD_ID || DEFAULT_CLOUD_ID, project: env.JIRA_PROJECT || 'SF', space: env.CONFLUENCE_SPACE || 'Eng', rootTitle: env.CONFLUENCE_ROOT_TITLE || 'Release notes',
    repository: env.GITHUB_REPOSITORY, version: env.VERSION, deployedSha: env.DEPLOYED_SHA, notesUrl: result.notesUrl, fetch, now};
  if (dryRun) {
    log('Deployment notification dry-run: payload written; no Slack request made.');
    if (jiraEligible || atlassianEligible) {
      const released = await releasedTickets(jiraOptions);
      released.warnings.forEach(message => warn(`Warning: ${message}`));
      if (jiraEligible) log(`Jira dry-run: would report ${released.tickets.length} released ticket(s)${released.tickets.length ? `: ${released.tickets.join(', ')}` : ''}`);
      if (atlassianEligible) {
        const preview = previewAtlassianRelease({...atlassianOptions, released});
        preview.lines.forEach(line => log(line));
        if (preview.body && env.CONFLUENCE_PAGE_FILE) await writeFile(env.CONFLUENCE_PAGE_FILE, preview.body + '\n', {mode: 0o600});
      }
    }
    return {...result, sent: false, skipped: false, dryRun: true};
  }
  // Each channel is independent: a Slack failure must not stop Jira or Atlassian, and vice versa.
  const failures = [];
  let slack = {sent: false, skipped: true}, jira = {sent: false, skipped: true, tickets: 0}, atlassian = {published: false, skipped: true};
  if (env.SLACK_WEBHOOK_URL) {
    try { slack = await sendSlack({webhook: env.SLACK_WEBHOOK_URL, payload: result.payload, fetch}); log('Slack accepted the deployment notification.'); }
    catch (error) { failures.push(error.message); }
  }
  // Computed once for both: if the shipped tickets can't be established, neither is updated.
  let released;
  if (jiraEligible || atlassianEligible) {
    try {
      released = await releasedTickets(jiraOptions);
      released.warnings.forEach(message => warn(`Warning: ${message}`));
    } catch (error) {
      if (jiraEligible) failures.push(`Jira not updated: ${error.message}`);
      if (atlassianEligible) failures.push(`Atlassian release not published: ${error.message}`);
    }
  }
  if (jiraEligible && released) {
    try {
      jira = await sendJiraRelease({webhook: env.JIRA_WEBHOOK_URL, secret: env.JIRA_WEBHOOK_SECRET, tickets: released.tickets, repository: env.GITHUB_REPOSITORY, version: env.VERSION, notesUrl: result.notesUrl || `https://github.com/${env.GITHUB_REPOSITORY}/pull/${released.releasePr.number}`, fetch});
      // Atlassian can answer 200 even for a wrong secret, so this is not proof the rule ran.
      if (jira.sent) log(`Jira webhook returned success for ${jira.tickets} ticket(s): ${released.tickets.join(', ')}. Check the rule's audit log to confirm it ran.`);
      else log('Jira: no tickets closed by this release (branch name or "Closes KEY"); nothing sent.');
    } catch (error) { failures.push(error.message.startsWith('Jira') ? error.message : `Jira not updated: ${error.message}`); }
  }
  if (atlassianEligible && released) {
    try {
      atlassian = await publishAtlassianRelease({...atlassianOptions, released});
      atlassian.warnings?.forEach(message => warn(`Warning: ${message}`));
      if (atlassian.published) {
        log(`Confluence release page: ${atlassian.pageUrl}`);
        log(`Jira release "${atlassian.versionName}" released ${atlassian.releaseDate}; fix version added to ${atlassian.fixVersions.added} ticket(s), ${atlassian.fixVersions.already} already had it, ${atlassian.fixVersions.skipped} skipped.`);
      } else log('Atlassian: no new production range for this deploy (redeploy or rollback); nothing published.');
    } catch (error) { failures.push(`Atlassian release not published: ${error.message}`); }
  }
  if (failures.length) throw new Error(failures.join('; '));
  return {...result, ...slack, slack, jira, atlassian};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Deployment notification failed: ${error.message}`); process.exitCode = 1; });
}
