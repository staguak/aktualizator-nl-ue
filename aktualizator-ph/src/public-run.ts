import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {publicCommand,executePublicCommand} from './public-command.js';
import {resolveRange} from './run-config.js';
import {executionRevision} from './execution-revision.js';
import {withOperationErrors,setErrorPhase,diagnosticChildEnvironment} from './operation-errors.js';

const root=fileURLToPath(new URL('../',import.meta.url));
async function main(){
  const plan=publicCommand(process.argv.slice(2),process.env);
  if(['initialize','update'].includes(plan.operation))resolveRange(root,plan.env);
  if(plan.planOnly){
    console.log(JSON.stringify({operation:plan.operation,namespace:plan.namespace,rangeTo:plan.rangeTo||null,
      sourceAudit:plan.sourceAudit,scope:'Command plan only; no authentication or Drive operation.'}));return;
  }
  plan.env.LAW_UPDATER_REVISION=executionRevision(root,plan.env);
  const run=(args:string[])=>new Promise<number>((resolve,reject)=>{
    setErrorPhase(args.includes('--check')?'PREFLIGHT':'MODULE_BUILD');
    const child=spawn(process.execPath,['--import','tsx','src/release-run.ts',...args],
      {cwd:root,env:diagnosticChildEnvironment('release',plan.env),stdio:'inherit'});
    child.once('error',()=>reject(new Error('Unable to start the release command.')));
    child.once('close',code=>resolve(code??1));
  });
  process.exitCode=await executePublicCommand(plan,run);
}
(process.argv.includes('--plan')?main():withOperationErrors('entry',root,main))
  .catch(()=>{console.error('Updater failed; inspect the private operation diagnostics.');process.exitCode=1;});
