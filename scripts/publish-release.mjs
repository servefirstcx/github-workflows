#!/usr/bin/env node
import {readFile, appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {publishRelease, outputLine} from './delivery.mjs';

export async function main(env = process.env, {fetch = globalThis.fetch, log = console.log, warn = console.warn} = {}) {
  let event;
  try { event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')); }
  catch { throw new Error('GITHUB_EVENT_PATH must contain a readable GitHub event JSON file'); }
  const result = await publishRelease({repository: env.GITHUB_REPOSITORY, token: env.GH_TOKEN, event, version: env.VERSION, tagPrefix: env.TAG_PREFIX ?? 'v', mainBranch: env.MAIN_BRANCH || 'main', releaseLabel: env.RELEASE_LABEL || 'release', fetch});
  const output = outputLine('release_url', result.url);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, output);
  for (const warning of result.warnings) warn(`Warning: ${warning}`);
  log('GitHub Release published and verified.');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Release publication failed: ${error.message}`); process.exitCode = 1; });
}
