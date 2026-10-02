#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {prepareDeployment, sendJiraRelease, sendSlack} from './delivery.mjs';

export async function main(env = process.env, {fetch = globalThis.fetch, log = console.log, warn = console.warn} = {}) {
  if (env.DRY_RUN && !['true', 'false'].includes(env.DRY_RUN)) throw new Error('DRY_RUN must be true or false');
  const dryRun = env.DRY_RUN === 'true';
  if (!env.SLACK_WEBHOOK_URL && !env.JIRA_WEBHOOK_URL && !dryRun) {
    log('Deployment notification skipped: no optional Slack or Jira webhook configured.');
    return {sent: false, skipped: true};
  }
  const result = await prepareDeployment({repository: env.GITHUB_REPOSITORY, token: env.GH_TOKEN, deployedSha: env.DEPLOYED_SHA, version: env.VERSION, environment: env.ENVIRONMENT, status: env.DEPLOY_STATUS, runUrl: env.RUN_URL, tagPrefix: env.TAG_PREFIX ?? 'v', mainBranch: env.MAIN_BRANCH || 'main', releaseLabel: env.RELEASE_LABEL || 'release', fetch});
  for (const warning of result.warnings) warn(`Warning: ${warning}`);
  if (dryRun || env.PAYLOAD_FILE) await writeFile(env.PAYLOAD_FILE || 'deployment-slack-payload.json', JSON.stringify(result.payload, null, 2) + '\n', {mode: 0o600});
  if (dryRun) {
    log('Deployment notification dry-run: payload written; no Slack request made.');
    if (result.tickets.length) log(`Jira dry-run: would report ${result.tickets.length} released ticket(s): ${result.tickets.join(', ')}`);
    return {...result, sent: false, skipped: false, dryRun: true};
  }
  // Each channel is independent: a Slack failure must not stop Jira, and vice versa.
  const failures = [];
  let slack = {sent: false, skipped: true}, jira = {sent: false, skipped: true, tickets: 0};
  if (env.SLACK_WEBHOOK_URL) {
    try { slack = await sendSlack({webhook: env.SLACK_WEBHOOK_URL, payload: result.payload, fetch}); log('Slack accepted the deployment notification.'); }
    catch (error) { failures.push(error.message); }
  }
  if (env.JIRA_WEBHOOK_URL) {
    if (result.notesAvailable && !result.tickets.length) log('Jira: verified release notes link no tickets; nothing to report.');
    else if (!result.notesAvailable && env.ENVIRONMENT === 'production' && env.DEPLOY_STATUS === 'success') warn('Warning: Jira not updated: release notes for this deployment could not be verified.');
    try {
      jira = await sendJiraRelease({webhook: env.JIRA_WEBHOOK_URL, secret: env.JIRA_WEBHOOK_SECRET, tickets: result.tickets, repository: env.GITHUB_REPOSITORY, version: env.VERSION, notesUrl: result.notesUrl, fetch});
      if (jira.sent) log(`Jira accepted ${jira.tickets} released ticket(s): ${result.tickets.join(', ')}`);
    } catch (error) { failures.push(error.message); }
  }
  if (failures.length) throw new Error(failures.join('; '));
  return {...result, ...slack, slack, jira};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Deployment notification failed: ${error.message}`); process.exitCode = 1; });
}
