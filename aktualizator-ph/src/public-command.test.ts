import test from 'node:test';
import assert from 'node:assert/strict';
import {publicCommand,executePublicCommand} from './public-command.js';
import {resolveRange,configFile} from './run-config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const id='11111111-1111-4111-8111-111111111111';
const actions={GITHUB_ACTIONS:'true',GITHUB_WORKFLOW:'Aktualizator prawa NL i UE',GITHUB_REF:'refs/heads/main',
  GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REPOSITORY:'example/copied-updater'};
test('a local copy defaults to full read-only verification; mutation requires approval',()=>{
  assert.deepEqual(publicCommand([],{}).releaseArgs,['--check','--full']);
  assert.throws(()=>publicCommand(['--operation=initialize'],{}),/approval/);
  assert.deepEqual(publicCommand(['--operation=initialize','--approve-mutation'],{}).releaseArgs,['--initialize']);
});
test('another owner can run a fork; PRs and non-main branches cannot publish',()=>{
  assert.equal(publicCommand(['--operation=update','--approve-mutation'],actions).mutating,true);
  for(const override of [{GITHUB_REF:'refs/pull/1/merge'},{GITHUB_REF:'refs/heads/contribution'},
    {GITHUB_EVENT_NAME:'pull_request_target'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_WORKFLOW:'Unreviewed'},
    {GITHUB_REPOSITORY:'../../unexpected'}])
    assert.throws(()=>publicCommand(['--operation=update','--approve-mutation'],{...actions,...override}),/trusted/);
});
test('schedule is explicitly opt-in, always uses a full source audit and cannot bypass its guard',()=>{
  const env={...actions,GITHUB_EVENT_NAME:'schedule',INPUT_APPROVE_MUTATION:'true'};
  assert.throws(()=>publicCommand([],env),/disabled/);
  const plan=publicCommand([],{...env,LAW_PAIRED_RELEASES_ENABLED:'true'});
  assert.equal(plan.operation,'update');assert.equal(plan.sourceAudit,'unconditional');
});
test('targeted operations reject malformed, extraneous and ambiguous input before OAuth',()=>{
  const approved={INPUT_APPROVE_MUTATION:'true'};
  for(const args of [['--operation=other'],['--operation=check','--range-to=2026-11-10'],
    ['--operation=update','--range-to=2026-02-30'],['--operation=recover','--target-release-id='+id],
    ['--operation=rollback','--target-release-id='+id+';echo'],['--namespace=release-test-100-1'],
    ['--namespace=../private'],['--operation=check','--operation=update'],['--unknown'],['--constructor=value'],['--config-dir=']])
    assert.throws(()=>publicCommand(args,approved));
  assert.deepEqual(publicCommand(['--operation=recover','--target-release-id='+id,'--expected-active-sha256=missing'],approved).releaseArgs,
    ['--recover='+id,'--expected-active-sha256=missing']);
});
test('a successful mutation requires a separate final byte check and propagates either failure',async()=>{
  const plan=publicCommand(['--operation=update','--approve-mutation'],{});
  for(const [codes,expected,count] of [[[7],7,1],[[0,8],8,2],[[0,0],0,2]] as const){
    const calls:string[][]=[];
    assert.equal(await executePublicCommand(plan,async args=>{calls.push(args);return codes[calls.length-1];}),expected);
    assert.equal(calls.length,count);if(count===2)assert.deepEqual(calls[1],['--check','--full']);
  }
});
test('external config directories control date resolution without changing repository files',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'updater-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'aktualizator.json'),JSON.stringify({schemaVersion:1,timeZone:'Europe/Warsaw',rangeFrom:'2024-01-01'}));
  const env={LAW_CONFIG_DIR:dir,LAW_RANGE_TO:'2026-11-10'};
  assert.equal(configFile('/unused','zakres.json',env),path.join(dir,'zakres.json'));
  assert.equal(resolveRange('/unused',env,new Date('2026-11-12T12:00:00Z')).rangeFrom,'2024-01-01');
});
test('real CLI planning needs no OAuth and cannot leak an inherited credential',()=>{
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('INPUT_')||key.startsWith('GITHUB_')||key.startsWith('LAW_')||key==='NODE_TEST_CONTEXT')delete env[key];
  env.GOOGLE_DRIVE_OAUTH_JSON='UNUSABLE_SECRET_NOT_FOR_OUTPUT';
  const r=spawnSync(process.execPath,['--import','tsx','src/public-run.ts','--plan'],{env,encoding:'utf8',timeout:15_000});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/no authentication/);
  assert(!r.stdout.includes(env.GOOGLE_DRIVE_OAUTH_JSON));assert(!r.stderr.includes(env.GOOGLE_DRIVE_OAUTH_JSON));
});
