import {spawn} from 'node:child_process';
import path from 'node:path';
import {ChildProcessFailure,diagnosticChildEnvironment} from './operation-errors.js';

export async function buildModules(scripts:string[],env:NodeJS.ProcessEnv):Promise<void>{
  // Wait for both children, including a healthy sibling after a failure. A
  // failed build can never race with publication or checkpoint packing.
  const results=await Promise.allSettled(scripts.map(script=>new Promise<void>((resolve,reject)=>{
    const role=path.basename(script)==='main.ts'?'NL':path.basename(script)==='eu-main.ts'?'EU':'pair';
    const child=spawn(process.execPath,['--import','tsx',script],{stdio:'inherit',env:diagnosticChildEnvironment(role,env)});
    child.on('error',reject);
    child.on('close',status=>status===0?resolve():reject(new Error(`Build ${script.split('/').at(-1)} exited with ${status??'signal'}.`)));
  })));
  const failures=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');
  if(failures.length)throw new ChildProcessFailure(failures.map(r=>r.reason instanceof Error?r.reason.message:String(r.reason)).join('; '));
}
