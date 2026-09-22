import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const block = workflow.split('      - name: Create Pull Request\n')[1].match(/          script: \|\n((?: {12}[^\n]*\n|\n)+)/)?.[1];
assert.ok(block, 'actual Create Pull Request script exists');
const source = block.split('\n').map(line => line.slice(12)).join('\n');
const run = new (Object.getPrototypeOf(async function() {}).constructor)('require','github','context','core',source);
const notes = '<!-- sf-release-notes:start -->\nQuotes " and apostrophes \' and $HOME stay literal.\n<!-- sf-release-notes:end -->';
function fixture(failure) {
  const state = {pr:null, creates:0, reads:0, outputs:{}, failure, labels:new Set(['release','automated'])};
  const fail = point => {if (state.failure === point) throw Object.assign(new Error(point), {status:503});};
  const github = {rest:{pulls:{
    list: async () => ({data:state.pr ? [state.pr] : []}),
    create: async input => {
      state.creates++;
      state.pr = {...input, number:7, node_id:'PR_7', state:'open', html_url:'https://github.com/example/app/pull/7',
        head:{ref:input.head,repo:{full_name:'example/app'}},base:{ref:input.base,repo:{full_name:'example/app'}}, labels:[]};
      return {data:{...state.pr}};
    },
    get: async () => {state.reads++;fail(state.reads === 1 ? 'body-read' : state.reads === 2 ? 'label-read' : 'ready-read');return {data:structuredClone(state.pr)};},
    update: async () => {throw new Error('must not PATCH human body');},
  },issues:{
    getLabel: async ({name}) => {fail('label-lookup');if (!state.labels.has(name)) throw Object.assign(new Error('missing'),{status:404});return {data:{name}};},
    createLabel: async ({name}) => {fail('label-create');state.labels.add(name);return {data:{name}};},
    addLabels: async ({labels}) => {fail('label-add');state.pr.labels=labels.map(name=>({name}));},
  }},graphql:async (query,variables) => {fail('mark-ready');assert.match(query,/markPullRequestReadyForReview/);assert.equal(variables.id,'PR_7');assert.ok(state.pr.labels.some(l=>l.name==='release'));state.pr.draft=false;return {};}};
  github.paginate = async (method, args) => (await method(args)).data;
  const invoke = async () => {
    const old = {...process.env};
    Object.assign(process.env,{VERSION:'1.2.3',NOTES_FILE:'fixture.md',MAIN_BRANCH:'main'});
    try {await run(name=>{assert.equal(name,'fs');return {readFileSync:()=>notes};},github,{repo:{owner:'example',repo:'app'}},{setOutput:(k,v)=>state.outputs[k]=v});}
    finally {for(const key of ['VERSION','NOTES_FILE','MAIN_BRANCH']) old[key]===undefined ? delete process.env[key] : process.env[key]=old[key];}
  };
  return {state,github,invoke};
}

test('release workflow transports literal Markdown and verifies ready labelled PR', async () => {
  const {state,invoke}=fixture();await invoke();
  assert.ok(state.pr.body.includes(notes));assert.equal(state.pr.head.ref,'release/1.2.3');assert.equal(state.pr.base.ref,'main');
  assert.equal(state.pr.draft,false);assert.equal(state.outputs.pr_number,7);assert.ok(state.pr.labels.some(l=>l.name==='release'));
});

function branchFixture(t) {
  const root=mkdtempSync(join(tmpdir(),'release-retry-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const remote=join(root,'remote.git'), seed=join(root,'seed'), runner=join(root,'runner');
  const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(root,'init','--bare',remote);git(root,'init','-b','stage',seed);
  git(seed,'config','user.email','test@example.invalid');git(seed,'config','user.name','Test');
  writeFileSync(join(seed,'package.json'),'{\n  "name": "fixture",\n  "version": "1.2.2"\n}\n');
  git(seed,'add','.');git(seed,'commit','-m','base');git(seed,'remote','add','origin',remote);git(seed,'push','origin','stage');
  git(root,'clone','-b','stage',remote,runner);
  git(runner,'config','user.email','test@example.invalid');git(runner,'config','user.name','Test');
  const output=join(root,'output');writeFileSync(output,'');
  const execute = name => {
    const step=workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name:')[0];assert.ok(step);
    if(step.includes("if: steps.release_branch.outputs.reused != 'true'") && readFileSync(output,'utf8').includes('reused=true'))return;
    const shell=step.match(/        run: \|\n([\s\S]*)/)[1].split('\n').map(l=>l.slice(10)).join('\n')
      .replaceAll('${{ steps.new_version.outputs.version }}','1.2.3').replaceAll('${{ steps.current_version.outputs.version }}','1.2.2')
      .replaceAll('${{ inputs.package_file }}','package.json').replaceAll('${{ inputs.package_lock }}','package-lock.json');
    const result=spawnSync('bash',['-eo','pipefail','-c',shell],{cwd:runner,encoding:'utf8',env:{...process.env,NEW_VERSION:'1.2.3',OLD_VERSION:'1.2.2',PACKAGE_FILE:'package.json',PACKAGE_LOCK:'package-lock.json',GITHUB_OUTPUT:output}});
    assert.equal(result.status,0,result.stderr+result.stdout);
  };
  const executeAll=()=>{for(const name of ['Create release branch','Update version in package.json','Commit version bump','Push release branch'])execute(name);};
  return {root,remote,seed,runner,git,execute,executeAll,output};
}

test('real git full rerun reuses release branch and preserves human commits', t => {
  const f=branchFixture(t);f.executeAll();
  assert.equal(JSON.parse(readFileSync(join(f.runner,'package.json'))).version,'1.2.3');
  writeFileSync(join(f.runner,'human.txt'),'keep this change');f.git(f.runner,'add','.');f.git(f.runner,'commit','-m','human change');f.git(f.runner,'push','origin','HEAD:release/1.2.3');
  const sha=f.git(f.runner,'rev-parse','HEAD');
  f.git(f.runner,'checkout','stage');f.git(f.runner,'branch','-D','release/1.2.3');writeFileSync(f.output,'');
  f.executeAll();
  assert.equal(f.git(f.runner,'rev-parse','HEAD'),sha);assert.equal(readFileSync(join(f.runner,'human.txt'),'utf8'),'keep this change');
  assert.equal(f.git(f.remote,'rev-parse','refs/heads/release/1.2.3'),sha);
});

for (const point of ['label-lookup','label-create','label-add','label-read','mark-ready','ready-read']) {
  test(`injected ${point} failure is safe and rerun recovers`, async () => {
    const {state,invoke}=fixture(point);
    if(point==='label-create')state.labels.clear();
    await assert.rejects(invoke,new RegExp(point));
    assert.ok(!state.pr || state.pr.draft || state.pr.labels.some(l=>l.name==='release'));
    assert.deepEqual(state.outputs,{});
    const number=state.pr?.number;state.failure=null;state.reads=0;
    await invoke();assert.equal(state.creates,1);assert.equal(state.pr.draft,false);
    if(number)assert.equal(state.pr.number,number);
  });
}

test('label create 422 race confirms label then completes', async () => {
  const {state,github,invoke}=fixture();state.labels.clear();
  github.rest.issues.createLabel=async ({name})=>{state.labels.add(name);throw Object.assign(new Error('race'),{status:422});};
  await invoke();assert.equal(state.pr.draft,false);
});

test('PR create conflict recovers exact open PR without overwriting human body', async () => {
  const {state,github,invoke}=fixture();const create=github.rest.pulls.create;
  github.rest.pulls.create=async input=>{await create(input);state.pr.body+='\nHuman checklist';throw Object.assign(new Error('conflict'),{status:422});};
  await invoke();assert.equal(state.creates,1);assert.ok(state.pr.body.endsWith('Human checklist'));assert.equal(state.pr.draft,false);
});

test('unresolved PR create conflict fails rather than claiming success', async () => {
  const {state,github,invoke}=fixture();
  github.rest.pulls.create=async ()=>{throw Object.assign(new Error('conflict'),{status:422});};
  await assert.rejects(invoke,/conflict/);assert.deepEqual(state.outputs,{});
});

for(const identity of ['closed','merged','ambiguous','wrong-head','wrong-base','wrong-repo']) {
  test(`does not accept ${identity} PR as recovered release`, async () => {
    const {state,github,invoke}=fixture();await invoke();state.outputs={};
    if(identity==='closed'||identity==='merged')state.pr.state='closed';
    if(identity==='ambiguous')github.rest.pulls.list=async()=>({data:[state.pr,state.pr]});
    if(identity==='wrong-head')state.pr.head.ref='release/9.9.9';
    if(identity==='wrong-base')state.pr.base.ref='other';
    if(identity==='wrong-repo')state.pr.head.repo.full_name='fork/app';
    github.rest.pulls.create=async()=>{throw Object.assign(new Error('conflict'),{status:422});};
    await assert.rejects(invoke);assert.deepEqual(state.outputs,{});
  });
}

test('existing release package mismatch fails without modifying remote', t => {
  const f=branchFixture(t);f.git(f.seed,'push','origin','HEAD:release/1.2.3');
  const before=f.git(f.remote,'rev-parse','refs/heads/release/1.2.3');
  assert.throws(()=>f.execute('Create release branch'),/version mismatch/);
  assert.equal(f.git(f.remote,'rev-parse','refs/heads/release/1.2.3'),before);
});

test('remote lookup failure is not treated as an absent branch', t => {
  const f=branchFixture(t);f.git(f.runner,'remote','set-url','origin',join(f.root,'nonexistent'));
  assert.throws(()=>f.execute('Create release branch'),/does not appear to be a git repository/);
  assert.equal(f.git(f.runner,'branch','--show-current'),'stage');assert.equal(readFileSync(f.output,'utf8'),'');
});

test('readback mismatches fail closed before reporting success', async t => {
  for (const mismatch of ['body','label','ready']) await t.test(mismatch, async () => {
    const {state,github,invoke}=fixture();
    if(mismatch==='body') {
      const get=github.rest.pulls.get;
      github.rest.pulls.get=async()=>{const result=await get();result.data.body='not saved';return result;};
    }
    if(mismatch==='label')github.rest.issues.addLabels=async()=>{};
    if(mismatch==='ready')github.graphql=async()=>({});
    await assert.rejects(invoke,/verification failed/);
    assert.equal(state.pr.draft,true);assert.deepEqual(state.outputs,{});
  });
});

test('label create 422 without an existing label fails before creating PR', async () => {
  const {state,github,invoke}=fixture();state.labels.clear();
  github.rest.issues.createLabel=async()=>{throw Object.assign(new Error('invalid label'),{status:422});};
  await assert.rejects(invoke,/missing/);assert.equal(state.creates,0);
});

test('rerun repairs legacy ready unlabelled PR without touching human body', async () => {
  const {state,invoke}=fixture();await invoke();
  state.pr.labels=[];state.pr.body+='\nHuman-edited release notes';
  const body=state.pr.body;await invoke();
  assert.equal(state.creates,1);assert.equal(state.pr.body,body);assert.equal(state.pr.draft,false);
  assert.ok(state.pr.labels.some(label=>label.name==='release'));
});

test('body read failure leaves a draft, and rerun repairs SAME PR preserving human body', async () => {
  const {state,invoke}=fixture('body-read');
  await assert.rejects(invoke,/body-read/);
  assert.equal(state.pr.draft,true,'new PR cannot be ready before body and labels verified');
  state.pr.body += '\nHuman review: - [x] Tests pass';
  const humanBody=state.pr.body;
  state.failure=null;state.reads=0;
  await invoke();
  assert.equal(state.creates,1);assert.equal(state.pr.body,humanBody);assert.equal(state.pr.draft,false);assert.equal(state.outputs.pr_number,7);
});
