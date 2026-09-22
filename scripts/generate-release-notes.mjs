#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { collectInventory, enrichWithJira, summarizeInventory, renderNotes } from './release-notes.mjs';

/** CLI env contract is intentionally explicit: GITHUB_TOKEN is NEVER an inference credential. */
export async function main(env = process.env, { cwd = process.cwd(), fetchImpl = fetch } = {}) {
  if (!env.NOTES_FILE) throw new Error('NOTES_FILE is required');
  const inventory = await collectInventory({ cwd, fetchImpl, repository: env.GITHUB_REPOSITORY,
    base: env.BASE_SHA, head: env.HEAD_SHA, token: env.GH_TOKEN,
    mainBranch: env.MAIN_BRANCH || 'main', stagingBranch: env.STAGING_BRANCH || 'stage',
    jiraBaseUrl: env.JIRA_BASE_URL || 'https://servefirst.atlassian.net' });
  inventory.items = await enrichWithJira(inventory.items, { fetchImpl, baseUrl: env.JIRA_BASE_URL || 'https://servefirst.atlassian.net',
    email: env.JIRA_EMAIL, token: env.JIRA_API_TOKEN });
  const result = await summarizeInventory(inventory, { fetchImpl, token: env.MODELS_TOKEN, model: env.AI_MODEL || 'openai/gpt-4.1-mini' });
  const markdown = renderNotes(result);
  writeFileSync(env.NOTES_FILE, markdown, 'utf8');
  return { ...result, markdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main();
    console.log(`Release notes written: ${result.items.length} items; ${result.aiUsed ? 'AI summaries' : 'deterministic summaries'}.`);
  } catch {
    // Never echo remote response bodies, credentials, or unsanitized git errors.
    console.error('Release notes generation failed. Check required inputs, complete git history, repository access and output path.');
    process.exitCode = 1;
  }
}
