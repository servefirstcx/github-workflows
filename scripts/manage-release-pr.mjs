import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Compatibility name: refresh now returns the PR snapshot plus comment_id/comment_url.
// GitHub offers no atomic conditional PR-body PATCH, so never rewrite reviewed text.
export async function updateReleasePr({api, number, head, notes}) {
  const pr = await api(`/pulls/${number}`);
  if (pr.state !== 'open' || pr.head?.sha !== head) throw new Error('Release PR head changed or is not open; rerun on the current head');
  const fence = '`'.repeat(Math.max(3, ...(notes.match(/`+/g) || []).map(run => run.length + 1)));
  const body = `## Release notes refresh suggestion\n\nSource head: ${head}\n\nReview and copy the Markdown below into the PR description's marked section, replacing the existing release-notes block including its markers. Preserve all checklist, bot and human sections outside that block. If no marked section exists, insert this block without removing existing text. Confirm the source head is still current before applying. This comment does not update the description.\n\n${fence}markdown\n${notes}\n${fence}`;
  const comment = await api(`/issues/${number}/comments`, 'POST', {body});
  if (!Number.isSafeInteger(comment?.id) || comment.id < 1) throw new Error('Could not verify release notes comment ID');
  const saved = await api(`/issues/comments/${comment.id}`);
  if (saved?.id !== comment.id || saved.body !== body) throw new Error('Could not verify release notes comment');
  return { ...pr, comment_id: saved.id, comment_url: saved.html_url };
}
const START = '<!-- sf-release-notes:start -->';
const END = '<!-- sf-release-notes:end -->';

async function main() {
  const env = process.env;
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '') ||
      !/^[1-9]\d*$/.test(env.PR_NUMBER || '') || !/^[0-9a-f]{40}$/.test(env.HEAD_SHA || '')) {
    throw new Error('Invalid repository, PR number or release head');
  }
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`, {
      method, headers: {Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'},
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    return response.json();
  };
  const notes = await readFile(env.NOTES_FILE, 'utf8');
  if (!notes.startsWith(START) || !notes.trimEnd().endsWith(END)) throw new Error('Invalid generated notes');
  const pr = await updateReleasePr({api, number: Number(env.PR_NUMBER), head: env.HEAD_SHA, notes: notes.trimEnd()});
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `pr_number=${pr.number}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Release notes update failed; check permissions and the current PR head.'); process.exitCode = 1; });
}
