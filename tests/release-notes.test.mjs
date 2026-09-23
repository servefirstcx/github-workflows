import test from 'node:test';
import assert from 'node:assert/strict';
const notes = await import('../scripts/release-notes.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const base = 'a'.repeat(40), head = 'b'.repeat(40);
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-notes-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  let n = 0;
  const commit = (message, filename = 'app.txt', content = `change ${++n}`) => {
    writeFileSync(join(cwd, filename), content);
    git('add', '.'); git('commit', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { cwd, git, commit, base: commit('initial') };
}
// HTTP fixtures below are deliberately mocked; git histories are real disposable repositories.
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const pr = (number, sha, extra = {}) => ({ number, title: `Fix ${number}`, body: '', merged_at: '2026-01-01T00:00:00Z', merge_commit_sha: sha,
  base: { ref: 'stage', repo: { full_name: 'acme/app' } }, head: { ref: `fix-${number}` }, ...extra });

test('inventory uses pinned git range, paginates associations, deduplicates and preserves direct commits', async t => {
  assert.equal(typeof notes.collectInventory, 'function', 'inventory is implemented');
  const r = repository(t), a = r.commit('SF-4417 Fix cache'), direct = r.commit('Fix production timeout'), b = r.commit('Fix export');
  const first = pr(100, a, { title: 'SF-4417 Fix cache', body: 'Also SF-4418', head: { ref: 'SF-4417-cache' } });
  const second = pr(101, b);
  const requests = [];
  const fetchImpl = async url => {
    requests.push(String(url));
    const u = new URL(url), sha = u.pathname.split('/').at(-2), page = u.searchParams.get('page');
    if (sha === a && page === '1') return response(Array.from({ length: 100 }, (_, i) => pr(200 + i, base)));
    if (sha === a && page === '2') return response([first, first, pr(999, b, { merged_at: null })]);
    return response(sha === b ? [second] : []);
  };
  const inventory = await notes.collectInventory({ cwd: r.cwd, repository: 'acme/app', base: r.base, head: b, token: 'mock-token', fetchImpl });
  assert.deepEqual(inventory.items.map(i => i.id), ['pr:100', `commit:${direct}`, 'pr:101']);
  assert.deepEqual(inventory.items[0].tickets.map(t => t.key), ['SF-4417', 'SF-4418']);
  assert.equal(inventory.items[0].url, 'https://github.com/acme/app/pull/100');
  assert.ok(requests.some(url => url.endsWith('per_page=100&page=2')));
  assert.equal(inventory.base, r.base);
  assert.equal(inventory.head, b);
});

test('housekeeping wrappers and version-only changes do not hide real fixes', async t => {
  const r = repository(t);
  const start = r.commit('initial version', 'package.json', '{"name":"app","version":"1.0.0"}');
  const feature = r.commit('Fix release automation');
  r.git('commit', '--allow-empty', '-m', 'Sync main to stage'); const sync = r.git('rev-parse', 'HEAD');
  const bump = r.commit('chore: bump version', 'package.json', '{"name":"app","version":"1.1.0"}');
  const direct = r.commit('release: fix version display');
  r.git('commit', '--allow-empty', '-m', 'Release stage'); const release = r.git('rev-parse', 'HEAD');
  const wrapper = pr(102, release, { base: { ref: 'main', repo: { full_name: 'acme/app' } }, head: { ref: 'stage' } });
  const mapping = { [feature]: [pr(100, feature), wrapper], [sync]: [pr(99, sync, { head: { ref: 'main' } }), wrapper],
    [bump]: [pr(103, bump, { title: 'Bump version' }), wrapper], [direct]: [wrapper], [release]: [wrapper] };
  const inventory = await notes.collectInventory({ cwd: r.cwd, repository: 'acme/app', base: start, head: release,
    token: 'mock', fetchImpl: async url => response(mapping[new URL(url).pathname.split('/').at(-2)]) });
  assert.deepEqual(inventory.items.map(i => i.id), ['pr:100', `commit:${direct}`]);
});

for (const scenario of ['conflict resolution', 'additional merge change', 'mechanical', 'nonempty single parent']) {
  test(`sync wrapper preserves changes: ${scenario}`, async t => {
    const r = repository(t);
    let sync;
    if (scenario === 'nonempty single parent') sync = r.commit('Sync main to stage');
    else {
      r.git('checkout', '-b', 'stage');
      r.commit('Stage change', scenario === 'conflict resolution' ? 'app.txt' : 'stage.txt', 'stage');
      r.git('checkout', 'main');
      r.commit('Main change', 'app.txt', 'main');
      if (scenario === 'conflict resolution') {
        assert.throws(() => r.git('merge', '--no-ff', '--no-commit', 'stage'));
        writeFileSync(join(r.cwd, 'app.txt'), 'manually resolved');
      } else {
        r.git('merge', '--no-ff', '--no-commit', 'stage');
        if (scenario === 'additional merge change') writeFileSync(join(r.cwd, 'extra.txt'), 'merge-only fix');
      }
      r.git('add', '.'); r.git('commit', '-m', 'Sync stage to main');
      sync = r.git('rev-parse', 'HEAD');
    }
    const wrapper = pr(102, sync, { base: { ref: 'main', repo: { full_name: 'acme/app' } }, head: { ref: 'stage' } });
    const inventory = await notes.collectInventory({ cwd: r.cwd, repository: 'acme/app', base: r.base, head: sync,
      token: 'mock', fetchImpl: async url => response(new URL(url).pathname.includes(sync) ? [wrapper] : []) });
    assert.equal(inventory.items.some(i => i.id === 'pr:102'), scenario !== 'mechanical');
    if (scenario === 'mechanical') assert.equal(inventory.items.length, 2, 'both underlying changes remain visible');
  });
}

test('explicit reverts remain visible separately and their original PR is not claimed shipped', async t => {
  const r = repository(t), feature = r.commit('Add export');
  r.git('revert', '--no-edit', feature); const revert = r.git('rev-parse', 'HEAD');
  const inventory = await notes.collectInventory({ cwd: r.cwd, repository: 'acme/app', base: r.base, head: revert, token: 'mock',
    fetchImpl: async url => response(new URL(url).pathname.includes(feature) ? [pr(4, feature, { title: 'Add export' })] : [pr(5, revert, { title: 'Revert export' })]) });
  assert.deepEqual(inventory.items.map(i => i.status), ['reverted', 'revert']);
  const markdown = notes.renderNotes({ ...inventory, summary: 'Changes recorded in this release range.' });
  assert.match(markdown, /## Reverts and reverted changes/);
  assert.ok(markdown.indexOf('[#4]') > markdown.indexOf('## Reverts'));
  assert.match(markdown, /reverted in this range; not claimed shipped/);
});

for (const associated of [false, true]) {
  for (const depth of [1, 2, 3, 4]) {
    test(`revert chain parity at depth ${depth} (${associated ? 'PR associations' : 'direct commits'})`, async t => {
      const r = repository(t), shas = [r.commit('Add export')];
      for (let i = 0; i < depth; i++) {
        r.git('revert', '--no-edit', shas.at(-1));
        shas.push(r.git('rev-parse', 'HEAD'));
      }
      const mapping = Object.fromEntries(shas.map((sha, i) => [sha, associated ? [pr(i + 1, sha, {
        title: i ? `Revert operation ${i}` : 'Add export',
        // The same edge is supplied by number AND git's full commit hash.
        body: i ? `Reverts #${i}\nReverts acme/app#${i}` : '',
      })] : []]));
      const inventory = await notes.collectInventory({ cwd: r.cwd, repository: 'acme/app', base: r.base,
        head: shas.at(-1), token: 'mock', fetchImpl: async url => response(mapping[new URL(url).pathname.split('/').at(-2)]) });
      const markdown = notes.renderNotes({ ...inventory, summary: 'Changes recorded in this release range.' });
      const shipped = markdown.split('## Included changes')[1].split('## Reverts and reverted changes')[0];
      assert.equal(shipped.includes('Add export'), depth % 2 === 0, 'original is shipped exactly when the chain reapplies it');
      assert.deepEqual(inventory.items.map(i => i.status), shas.map((_, i) =>
        (depth - i) % 2 ? 'reverted' : i ? 'revert' : 'included'));
      assert.equal(r.git('show', 'HEAD:app.txt'), depth % 2 ? r.git('show', `${r.base}:app.txt`) : r.git('show', `${shas[0]}:app.txt`));
    });
  }
}

test('revert activation follows merge commit order, not early PR association emission', async t => {
  const r = repository(t), precursor = r.commit('Prepare reapply', 'prepare.txt');
  const feature = r.commit('Add export');
  r.git('revert', '--no-edit', feature); const undo = r.git('rev-parse', 'HEAD');
  r.git('revert', '--no-edit', undo); const reapply = r.git('rev-parse', 'HEAD');
  const last = pr(3, reapply, { title: 'Revert undo', body: 'Reverts #2' });
  const mapping = { [precursor]: [last], [feature]: [pr(1, feature, { title: 'Add export' })],
    [undo]: [pr(2, undo, { title: 'Revert export', body: 'Reverts #1' })], [reapply]: [last] };
  const inventory = await notes.collectInventory({ cwd: r.cwd, repository: 'acme/app', base: r.base,
    head: reapply, token: 'mock', fetchImpl: async url => response(mapping[new URL(url).pathname.split('/').at(-2)]) });
  assert.deepEqual(inventory.items.map(i => [i.number, i.status]), [[3, 'revert'], [1, 'included'], [2, 'reverted']]);
  const shipped = notes.renderNotes({ ...inventory, summary: 'Recorded changes.' }).split('## Included changes')[1].split('## Reverts and reverted changes')[0];
  assert.match(shipped, /Add export/);
});

test('revert references cannot point forward or form cycles', async t => {
  const r = repository(t), first = r.commit('Earlier operation'), second = r.commit('Later operation');
  const mapping = { [first]: [pr(1, first, { title: 'Revert future', body: 'Reverts #2\nReverts #1' })],
    [second]: [pr(2, second, { title: 'Revert earlier', body: 'Reverts #1' })] };
  const inventory = await notes.collectInventory({ cwd: r.cwd, repository: 'acme/app', base: r.base,
    head: second, token: 'mock', fetchImpl: async url => response(mapping[new URL(url).pathname.split('/').at(-2)]) });
  assert.deepEqual(inventory.items.map(i => i.status), ['reverted', 'revert']);
});

test('optional Jira context is bounded, title/description-only, deduplicated and fail-soft', async () => {
  assert.equal(typeof notes.enrichWithJira, 'function', 'Jira context is implemented');
  const items = [{ id: 'pr:1', title: 'Fix', tickets: [{ key: 'SF-1', url: 'https://servefirst.atlassian.net/browse/SF-1' }] },
    { id: 'pr:2', title: 'Also fix', tickets: [{ key: 'SF-1' }, { key: 'SF-2' }] }];
  let calls = 0;
  const enriched = await notes.enrichWithJira(items, { email: 'mock@example.invalid', token: 'mock-jira-secret',
    fetchImpl: async (url, options) => {
      calls++; assert.match(url, /^https:\/\/servefirst.atlassian.net\/rest\/api\/3\/issue\/SF-\d\?fields=summary,description$/);
      assert.equal(options.redirect, 'error'); assert.ok(options.signal);
      if (url.includes('SF-2')) return response({ secret: 'never log body' }, 403);
      return response({ fields: { summary: 'Cache fix', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Correct tenant key.' }] }] }, assignee: { name: 'private' } } });
    } });
  assert.equal(calls, 2);
  assert.deepEqual(enriched[0].tickets[0].context, { title: 'Cache fix', description: 'Correct tenant key.' });
  assert.ok(!JSON.stringify(enriched).includes('private'));
  assert.equal(enriched[1].tickets[1].context, undefined);
  for (const baseUrl of ['http://servefirst.atlassian.net', 'https://evil.test', 'https://servefirst.atlassian.net.evil.test', 'https://user:pass@servefirst.atlassian.net', 'https://servefirst.atlassian.net/path']) {
    await notes.enrichWithJira(items, { baseUrl, email: 'mock', token: 'mock', fetchImpl: () => { throw new Error('must not request'); } });
  }
});

test('AI uses Models token only, bounded chunks, strict known-ID JSON and no credentials in prompts', async () => {
  assert.equal(typeof notes.summarizeInventory, 'function', 'AI summarizer is implemented');
  const inventory = { base, head, items: Array.from({ length: 12 }, (_, i) => ({ id: `pr:${i + 1}`, kind: 'pr', number: i + 1,
    title: `Fix export ${i + 1}`, body: 'Untrusted context. '.repeat(1000), status: 'included', tickets: [], token: 'must-not-leak' })) };
  const calls = [];
  const result = await notes.summarizeInventory(inventory, { token: 'mock-models-token', fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(url, 'https://models.github.ai/inference/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer mock-models-token');
    assert.ok(!options.body.includes('must-not-leak') && !options.body.includes('mock-models-token'));
    const body = JSON.parse(options.body); assert.equal(body.model, 'openai/gpt-4.1-mini');
    assert.match(body.messages[0].content, /untrusted/i);
    assert.ok(body.messages[1].content.length <= 16000);
    const data = JSON.parse(body.messages[1].content);
    return response({ choices: [{ message: { content: JSON.stringify({ overview: 'Export handling improvements.', summaries: Object.fromEntries(data.items.map(i => [i.id, 'Fixes export handling.'])) }) } }] });
  } });
  assert.ok(calls.length > 1, 'large inventories are chunked');
  assert.deepEqual(result.items.map(i => i.id), inventory.items.map(i => i.id));
  assert.ok(result.items.every(i => i.summary === 'Fixes export handling.'));
  assert.equal(result.aiUsed, true);
  let requested = false;
  const fallback = await notes.summarizeInventory(inventory, { fetchImpl: async () => { requested = true; } });
  assert.equal(requested, false);
  assert.equal(fallback.aiUsed, false);
  assert.equal(fallback.items[0].summary, inventory.items[0].title);
});

test('any AI failure, invented membership/link or duplicate ID falls back without dropping inventory', async () => {
  const inventory = { base, head, items: [{ id: 'pr:7', kind: 'pr', title: 'Fix cache', tickets: [] }] };
  const contents = ['not JSON', '{"overview":"Fine.","summaries":{}}',
    '{"overview":"Fine.","summaries":{"pr:7":"Fix.","pr:8":"Invented."}}',
    '{"overview":"Fine.","summaries":{"pr:7":"https://evil.test"}}',
    '{"overview":"Fine.","summaries":{"pr:7":"Fix.","pr:7":"Another fix."}}'];
  for (const content of contents) {
    const result = await notes.summarizeInventory(inventory, { token: 'mock', fetchImpl: async () => response({ choices: [{ message: { content } }] }) });
    assert.equal(result.aiUsed, false, content);
    assert.deepEqual(result.items.map(i => [i.id, i.summary]), [['pr:7', 'Fix cache']]);
  }
  for (const fetchImpl of [async () => response({}, 429), async () => { throw new Error('secret HTTP body'); }]) {
    assert.equal((await notes.summarizeInventory(inventory, { token: 'mock', fetchImpl })).aiUsed, false);
  }
});

test('CLI writes only the marked block, requires NOTES_FILE, never uses GITHUB_TOKEN for AI', async t => {
  const cli = await import('../scripts/generate-release-notes.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
  assert.equal(typeof cli.main, 'function', 'CLI is implemented');
  const r = repository(t), feature = r.commit('Fix direct outage'), output = join(r.cwd, 'notes.md');
  const env = { GH_TOKEN: 'mock-gh', GITHUB_TOKEN: 'must-not-use-for-models', GITHUB_REPOSITORY: 'acme/app', BASE_SHA: r.base, HEAD_SHA: feature, NOTES_FILE: output };
  const requests = [];
  await cli.main(env, { cwd: r.cwd, fetchImpl: async url => { requests.push(url); return response([]); } });
  const markdown = readFileSync(output, 'utf8');
  assert.equal(notes.extractNotes(markdown).markdown, markdown.trim());
  assert.match(markdown, /direct\/unassociated commit/);
  assert.ok(requests.every(url => url.startsWith('https://api.github.com/')));
  await assert.rejects(cli.main({ ...env, NOTES_FILE: '' }, { cwd: r.cwd }), /NOTES_FILE/);
  // Exercise the real entrypoint too: empty pinned range does not need network mocking.
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/generate-release-notes.mjs', import.meta.url))], {
    cwd: r.cwd, env: { ...process.env, ...env, HEAD_SHA: r.base, MODELS_TOKEN: '', JIRA_API_TOKEN: '' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /No non-housekeeping changes/);
});

test('malformed GitHub responses and API errors fail inventory, unsafe Jira config cannot inject links', async t => {
  const r = repository(t), feature = r.commit('SF-1 Fix cache');
  const config = { cwd: r.cwd, repository: 'acme/app', base: r.base, head: feature, token: 'mock' };
  for (const fetchImpl of [async () => response({ message: 'private response' }, 403), async () => response({ items: [] }), async () => response([{}])]) {
    await assert.rejects(notes.collectInventory({ ...config, fetchImpl }), /GitHub|Remote/);
  }
  await assert.rejects(notes.collectInventory({ ...config, base: '--all', fetchImpl: async () => response([]) }), /SHAs/);
  const inventory = await notes.collectInventory({ ...config, jiraBaseUrl: 'https://evil.test/path) @everyone', fetchImpl: async () => response([]) });
  assert.equal(inventory.items[0].tickets[0].url, 'https://servefirst.atlassian.net/browse/SF-1');
});

test('shallow history fails closed even when both pinned objects exist', async t => {
  const r = repository(t), feature = r.commit('Fix timeout'), shallow = join(r.cwd, 'shallow');
  r.git('clone', '--depth=1', `file://${r.cwd}`, shallow);
  await assert.rejects(notes.collectInventory({ cwd: shallow, repository: 'acme/app', base: feature, head: feature,
    token: 'mock', fetchImpl: async () => response([]) }), /complete|shallow/i);
});

test('AI length budget includes JSON escaping and never sends oversized prompt data', async () => {
  const lengths = [];
  const inventory = { base, head, items: [{ id: 'pr:1', title: 'Safe title', body: '\u0001'.repeat(3000), tickets: [] }] };
  const result = await notes.summarizeInventory(inventory, { token: 'mock', fetchImpl: async (url, options) => {
    lengths.push(JSON.parse(options.body).messages[1].content.length);
    return response({}, 429);
  } });
  assert.ok(lengths.every(n => n <= 16000));
  assert.equal(result.items.length, 1);
});

test('association ordering is deterministic and Link pagination never follows a foreign host', async t => {
  const r = repository(t), sha = r.commit('Fix shared change'), urls = [];
  const inventory = await notes.collectInventory({ cwd: r.cwd, repository: 'acme/app', base: r.base, head: sha, token: 'mock', fetchImpl: async url => {
    urls.push(url);
    return new URL(url).searchParams.get('page') === '1'
      ? response([pr(2, sha)], 200, { link: '<https://evil.test/token>; rel="next"' }) : response([pr(1, sha)]);
  } });
  assert.deepEqual(inventory.items.map(i => i.id), ['pr:1', 'pr:2']);
  assert.equal(urls.length, 2);
  assert.ok(urls.every(u => u.startsWith('https://api.github.com/')));
});

test('GitHub-style explicit revert references mark originals without relying on commit text', async t => {
  const r = repository(t), a = r.commit('Feature A'), b = r.commit('Feature B'), revert = r.commit('Undo exports');
  const mapping = { [a]: [pr(1, a)], [b]: [pr(2, b)], [revert]: [pr(3, revert, { title: 'Revert exports',
    body: 'Reverts acme/app#1\nReverts https://github.com/acme/app/pull/2\nReverts another/repo#99' })] };
  const inventory = await notes.collectInventory({ cwd: r.cwd, repository: 'acme/app', base: r.base, head: revert,
    token: 'mock', fetchImpl: async url => response(mapping[new URL(url).pathname.split('/').at(-2)]) });
  assert.deepEqual(inventory.items.map(i => i.status), ['reverted', 'reverted', 'revert']);
});

test('renderer rejects forged links and suppresses autolinks in untrusted prose', () => {
  const item = { id: 'pr:7', kind: 'pr', number: 7, title: 'Visit https://evil.test @team', tickets: [], url: 'https://github.com/acme/app/pull/7' };
  assert.ok(!notes.renderNotes({ base, head, summary: 'Fine.', items: [item] }).includes('https://evil.test'));
  assert.throws(() => notes.renderNotes({ base, head, summary: 'Fine.', items: [{ ...item, url: 'javascript:alert(1)' }] }), /link/i);
  assert.throws(() => notes.renderNotes({ base, head, summary: 'Fine.', items: [{ ...item, tickets: [{ key: 'SF-1', url: 'https://evil.test' }] }] }), /link/i);
});

test('marked notes round-trip human edits with pinned provenance and safe text', () => {
  assert.equal(typeof notes.renderNotes, 'function', 'renderer is implemented');
  const markdown = notes.renderNotes({ base, head, summary: 'Short overall summary.', items: [{
    id: 'pr:7', kind: 'pr', number: 7, url: 'https://github.com/acme/app/pull/7',
    title: '<b>Fix</b> @everyone [bad](https://evil.test)\u0000',
    tickets: [{ key: 'SF-7', url: 'https://servefirst.atlassian.net/browse/SF-7' }],
  }] });
  assert.ok(markdown.startsWith('<!-- sf-release-notes:start -->'));
  assert.ok(markdown.endsWith('<!-- sf-release-notes:end -->\n'));
  assert.match(markdown, /\[#7\]\(https:\/\/github.com\/acme\/app\/pull\/7\)/);
  assert.match(markdown, /\[SF-7\]\(https:\/\/servefirst.atlassian.net\/browse\/SF-7\)/);
  assert.ok(!markdown.includes('<b>') && !markdown.includes('@everyone'));
  assert.ok(markdown.includes('\\[bad\\]'));
  const edited = markdown.replace('Short overall summary.', 'Human-edited summary.');
  assert.ok(edited.includes('Human-edited summary.'), 'ordinary punctuation stays readable/editable');
  assert.deepEqual(notes.extractNotes(`Release intro\n${edited}\nChecklist`), { markdown: edited.trim(), base, head });
  assert.equal(notes.extractNotes('plain release body'), null);
});
