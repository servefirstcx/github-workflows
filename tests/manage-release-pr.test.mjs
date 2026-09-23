import test from 'node:test';
import assert from 'node:assert/strict';
import { updateReleasePr } from '../scripts/manage-release-pr.mjs';

const head = 'a'.repeat(40);
const start = '<!-- sf-release-notes:start -->';
const end = '<!-- sf-release-notes:end -->';
const notes = `${start}\nNew summary\n${end}`;

test('refresh suggests copyable notes without overwriting concurrent human edits', async () => {
  let body = `# Release\n${start}\nOld notes\n${end}\n- [ ] Tested\n<!-- CURSOR_SUMMARY -->Keep me`;
  const edited = body.replace('- [ ] Tested', '- [x] Tested') + '\nHuman concurrent edit';
  let comment;
  const calls = [];
  const api = async (path, method = 'GET', payload) => {
    calls.push([path, method]);
    if (path === '/pulls/1' && method === 'GET') {
      const snapshot = { number: 1, state: 'open', head: { sha: head }, body };
      body = edited;
      return snapshot;
    }
    assert.notEqual(method, 'PATCH', 'no API may replace the PR description');
    if (path === '/issues/1/comments' && method === 'POST') {
      body += '\nAnother edit during POST';
      comment = { id: 123, html_url: 'https://github.com/acme/app/pull/1#issuecomment-123', body: payload.body };
      return comment;
    }
    assert.equal(path, '/issues/comments/123');
    return comment;
  };
  const result = await updateReleasePr({ api, number: 1, head, notes });
  assert.equal(body, edited + '\nAnother edit during POST');
  assert.match(comment.body, /review[\s\S]*copy/i);
  assert.match(comment.body, /marked section/i);
  assert.ok(comment.body.includes(head));
  assert.ok(comment.body.includes('```markdown\n' + notes + '\n```'));
  assert.equal(result.number, 1);
  assert.equal(result.comment_id, 123);
  assert.equal(result.comment_url, comment.html_url);
  assert.deepEqual(calls, [['/pulls/1', 'GET'], ['/issues/1/comments', 'POST'], ['/issues/comments/123', 'GET']]);
});

test('refresh fences exact Markdown safely including backticks and literal dollars', async () => {
  const supplied = `${start}\n$& $1 $$\n\`\`\`js\nexample\n\`\`\`\n\`\`\`\`\`\n${end}\n`;
  let comment;
  const api = async (path, method = 'GET', payload) => {
    if (path === '/pulls/1') return { number: 1, state: 'open', head: { sha: head } };
    if (method === 'POST') comment = { id: 123, body: payload.body };
    return comment;
  };
  await updateReleasePr({ api, number: 1, head, notes: supplied });
  const fence = comment.body.match(/\n(`{3,})markdown\n/)[1];
  assert.ok(fence.length > 5, 'outer fence must exceed every inner backtick run');
  assert.ok(comment.body.endsWith(`${fence}markdown\n${supplied}\n${fence}`), 'copyable Markdown is unchanged');
});

for (const failure of ['changed body', 'wrong id', 'missing id', 'read error']) {
  test(`refresh rejects comment readback failure: ${failure}`, async () => {
    let postedBody;
    const api = async (path, method = 'GET', payload) => {
      if (path === '/pulls/1') return { number: 1, state: 'open', head: { sha: head } };
      if (method === 'POST') {
        postedBody = payload.body;
        return { id: failure === 'missing id' ? undefined : 123, body: postedBody };
      }
      if (failure === 'read error') throw new Error('readback unavailable');
      return { id: failure === 'wrong id' ? 456 : 123, body: failure === 'changed body' ? 'not the posted body' : postedBody };
    };
    await assert.rejects(updateReleasePr({ api, number: 1, head, notes }), /verify|readback/);
  });
}

for (const pr of [{ state: 'open', head: { sha: 'b'.repeat(40) } }, { state: 'closed', head: { sha: head } }]) {
  test(`refresh rejects ${pr.state === 'closed' ? 'closed PR' : 'moved head'} before posting`, async () => {
    let writes = 0;
    const api = async (path, method = 'GET') => { if (method !== 'GET') writes++; return pr; };
    await assert.rejects(updateReleasePr({ api, number: 1, head, notes }), /head changed|open/);
    assert.equal(writes, 0);
  });
}
