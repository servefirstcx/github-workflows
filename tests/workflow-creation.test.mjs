import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Execute the actual workflow's github-script source against explicit API fixtures.
// This verifies JSON/body transport without creating a remote PR.
test('release workflow transports generated Markdown literally and verifies the saved PR/labels', async () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const block = workflow.match(/          script: \|\n((?: {12}[^\n]*\n|\n)+)/)?.[1];
  assert.ok(block, 'actual Create Pull Request script exists');
  const source = block.split('\n').map(line => line.slice(12)).join('\n');
  const run = new (Object.getPrototypeOf(async function() {}).constructor)('require','github','context','core',source);
  const notes = '<!-- sf-release-notes:start -->\nQuotes " and apostrophes \' and $HOME stay literal.\n<!-- sf-release-notes:end -->';
  const env = {VERSION: process.env.VERSION, NOTES_FILE: process.env.NOTES_FILE, MAIN_BRANCH: process.env.MAIN_BRANCH};
  Object.assign(process.env, {VERSION:'1.2.3',NOTES_FILE:'fixture.md',MAIN_BRANCH:'main'});
  let saved, labelled = false, reads = 0;
  const outputs = {};
  const github = {rest: {
    pulls: {
      create: async body => {saved = {...body,number:7,html_url:'https://github.com/example/app/pull/7'}; return {data:saved};},
      get: async () => {reads++; return {data:{...saved,labels:labelled ? [{name:'release'}] : []}};},
    },
    issues: {
      getLabel: async () => ({data:{}}),
      addLabels: async ({labels}) => {assert.deepEqual(labels,['release','automated']);labelled=true;},
    },
  }};
  try {
    await run(name => {assert.equal(name,'fs');return {readFileSync: file => {assert.equal(file,'fixture.md');return notes;}};},github,{repo:{owner:'example',repo:'app'}},{setOutput:(k,v)=>outputs[k]=v});
    assert.ok(saved.body.includes(notes));
    assert.equal(saved.head,'release/1.2.3');
    assert.equal(saved.base,'main');
    assert.equal(saved.draft,false);
    assert.equal(outputs.pr_number,7);
    assert.equal(reads,2);
    assert.ok(labelled);
  } finally {
    for (const [key,value] of Object.entries(env)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
