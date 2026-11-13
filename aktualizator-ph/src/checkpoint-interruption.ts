import {isDeepStrictEqual} from 'node:util';
import {validateContext} from './release-engine.js';
import type {RunContext} from './release-engine.js';
import {readJson,writeJson} from './release-store.js';
import type {ReleaseStore} from './release-store.js';

// Only the isolated acceptance harness may stop a module at a verified
// checkpoint. A repeated priming attempt preserves the first immutable receipt
// and stops immediately after restoring the already verified completed acts.
export async function interruptVerifiedCheckpoint(store:ReleaseStore,context:RunContext,module:'NL'|'EU',
  phase:'base'|'release',completedActs:number,env:NodeJS.ProcessEnv=process.env){
  if(env.LAW_TEST_INTERRUPT_MODULE!==module||phase!=='base')return;
  const after=Number(env.LAW_TEST_INTERRUPT_AFTER);
  if(!/^release-test-corpus-\d+-\d+$/.test(env.LAW_RELEASE_NAMESPACE??'')||!Number.isInteger(after)||after<1||
    !Number.isInteger(completedActs)||completedActs<0)
    throw new Error('Fault injection requires an isolated corpus workflow namespace and valid act counts.');
  validateContext(context);if(completedActs<after)return;
  const key=`checks/faults/${context.runId}-${module}.json`,saved=await readJson(store,key) as any;
  if(saved!==null){
    if(saved.schemaVersion!==1||saved.module!==module||saved.phase!==phase||!isDeepStrictEqual(saved.context,context)||
      !Number.isInteger(saved.completedActs)||saved.completedActs<after||saved.completedActs>completedActs||
      typeof saved.confirmedAt!=='string'||!Number.isFinite(Date.parse(saved.confirmedAt)))
      throw new Error('Conflicting deliberate checkpoint interruption receipt.');
  }else{
    await writeJson(store,key,{schemaVersion:1,context,module,phase,completedActs,confirmedAt:new Date().toISOString()},true);
  }
  console.log(`TEST_INTERRUPT_CONFIRMED:${module}:${phase}:${saved?.completedActs??completedActs}`);
  throw new Error('Deliberate test interruption after verified durable checkpoint.');
}
