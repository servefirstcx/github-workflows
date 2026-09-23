#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {prepareDeployment, sendSlack} from './delivery.mjs';

export async function main(env = process.env, {fetch = globalThis.fetch, log = console.log, warn = console.warn} = {}) {
  if (env.DRY_RUN && !['true', 'false'].includes(env.DRY_RUN)) throw new Error('DRY_RUN must be true or false');
  const dryRun = env.DRY_RUN === 'true';
  if (!env.SLACK_WEBHOOK_URL && !dryRun) {
    log('Deployment notification skipped: no optional Slack webhook configured.');
    return {sent: false, skipped: true};
  }
  const result = await prepareDeployment({repository: env.GITHUB_REPOSITORY, token: env.GH_TOKEN, deployedSha: env.DEPLOYED_SHA, version: env.VERSION, environment: env.ENVIRONMENT, status: env.DEPLOY_STATUS, runUrl: env.RUN_URL, tagPrefix: env.TAG_PREFIX ?? 'v', mainBranch: env.MAIN_BRANCH || 'main', releaseLabel: env.RELEASE_LABEL || 'release', fetch});
  for (const warning of result.warnings) warn(`Warning: ${warning}`);
  if (dryRun || env.PAYLOAD_FILE) await writeFile(env.PAYLOAD_FILE || 'deployment-slack-payload.json', JSON.stringify(result.payload, null, 2) + '\n', {mode: 0o600});
  if (dryRun) {
    log('Deployment notification dry-run: payload written; no Slack request made.');
    return {...result, sent: false, skipped: false, dryRun: true};
  }
  const delivery = await sendSlack({webhook: env.SLACK_WEBHOOK_URL, payload: result.payload, fetch});
  log('Slack accepted the deployment notification.');
  return {...result, ...delivery};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Deployment notification failed: ${error.message}`); process.exitCode = 1; });
}
