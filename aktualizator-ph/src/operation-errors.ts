import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {safeCacheDirectory} from './cache-directory.js';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const roles=['entry','release','pair','NL','EU'] as const;
type Role=typeof roles[number];
export const errorPhases=['CONFIGURATION','AUTHENTICATION','STORAGE_OPEN','PREFLIGHT','RESUME','BASE_PLANNING',
  'CHECKPOINT','SOURCE_DISCOVERY','SOURCE_BUILD','OUTPUT_WRITE','OUTPUT_VALIDATION','MODULE_BUILD',
  'PREPARE_GENERATION','COMMIT','FINALIZATION','RETENTION','SOURCE_CHECK','ROLLBACK','RECOVERY','DIAGNOSTIC','UNSCOPED'] as const;
type Phase=typeof errorPhases[number];
const profile='operation-error-registry-v1';
const safeCodes=['CHILD_PROCESS_FAILED','OPERATION_FAILED','ECONNRESET','ETIMEDOUT','EPIPE','ECONNABORTED','ENOTFOUND','EAI_AGAIN','ENOENT','EACCES','ENOSPC'];
export class ChildProcessFailure extends Error {}
const local=new AsyncLocalStorage<{registry:OperationErrors;phase:Phase}>();

// Do not serialize Error.message, stack, cause, SDK objects or arbitrary codes.
// Even an ordinary Error may contain a token, a URL or an entire response body.
function classification(error:unknown){
  if(error instanceof ChildProcessFailure)return {code:'CHILD_PROCESS_FAILED',httpStatus:null};
  const e=error as any,status=e?.response?.status??e?.status;
  return {code:safeCodes.slice(2).includes(e?.code)?e.code:'OPERATION_FAILED',
    httpStatus:Number.isInteger(status)&&status>=100&&status<=599?status:null};
}
function context(env:NodeJS.ProcessEnv){
  let c:any;try{c=JSON.parse(env.LAW_RELEASE_CONTEXT??'null');}catch{}
  return {runId:uuid.test(c?.runId??'')?c.runId:null,releaseId:uuid.test(c?.releaseId??'')?c.releaseId:null,
    codeRevision:/^[a-f0-9]{40}$/.test(env.LAW_UPDATER_REVISION??'')?env.LAW_UPDATER_REVISION:null,
    githubRunId:/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID??'')?env.GITHUB_RUN_ID:null,
    githubRunAttempt:/^[1-9]\d{0,5}$/.test(env.GITHUB_RUN_ATTEMPT??'')?env.GITHUB_RUN_ATTEMPT:null,
    generationPhase:['base','release'].includes(env.LAW_RELEASE_PHASE??'')?env.LAW_RELEASE_PHASE:'standalone'};
}
function projectedContext(value:any){return context({LAW_RELEASE_CONTEXT:JSON.stringify({runId:value?.runId,releaseId:value?.releaseId}),
  LAW_UPDATER_REVISION:value?.codeRevision,GITHUB_RUN_ID:value?.githubRunId,
  GITHUB_RUN_ATTEMPT:value?.githubRunAttempt,LAW_RELEASE_PHASE:value?.generationPhase});}

export class OperationErrors {
  readonly traceId:string;readonly processId:string;readonly parentId:string|null;
  private directory:string;private seen=new Set<unknown>();private errors=0;private children=0;private finished=false;
  private concurrent=new Map<unknown,unknown[]>();
  private wrappedClassification=new Map<unknown,ReturnType<typeof classification>>();
  private operationContext:ReturnType<typeof context>;
  constructor(directory:string,readonly role:Role,env:NodeJS.ProcessEnv={}){
    const inherited=[env.LAW_DIAGNOSTIC_TRACE_ID,env.LAW_DIAGNOSTIC_PROCESS_ID,env.LAW_DIAGNOSTIC_PARENT_ID];
    if(inherited.some(v=>v!==undefined)&&!inherited.every(v=>typeof v==='string'&&uuid.test(v)))
      throw new Error('Invalid diagnostic process identity.');
    if(!roles.includes(role))throw new Error('Invalid diagnostic role.');
    this.traceId=inherited[0]??randomUUID();this.processId=inherited[1]??randomUUID();this.parentId=inherited[2]??null;
    this.operationContext=context(env);this.directory=path.join(directory,this.traceId,this.processId);
    this.write('started.json',{kind:'started'});
  }
  private write(name:string,record:Record<string,unknown>){
    try{
      if(!safeCacheDirectory(this.directory))throw new Error();
      fs.mkdirSync(this.directory,{recursive:true});
      if(!safeCacheDirectory(this.directory))throw new Error();
      fs.writeFileSync(path.join(this.directory,name),JSON.stringify({profile,traceId:this.traceId,processId:this.processId,
        parentId:this.parentId,role:this.role,context:this.operationContext,...record})+'\n',{flag:'wx',mode:0o600});
    }catch{throw new Error('Operation error evidence persistence failed.');}
  }
  bind(env:NodeJS.ProcessEnv){this.operationContext=context(env);}
  rememberConcurrent(errors:unknown[]){
    if(errors.length>1)this.concurrent.set(errors[0],[...(this.concurrent.get(errors[0])??[]),...errors.slice(1)]);
  }
  preserveWrappedFailure(original:unknown,wrapped:unknown){
    this.wrappedClassification.set(wrapped,this.wrappedClassification.get(original)??classification(original));
    const siblings=this.concurrent.get(original);
    if(siblings)this.concurrent.set(wrapped,[...(this.concurrent.get(wrapped)??[]),...siblings]);
  }
  record(error:unknown,phase:Phase){
    if(this.finished)throw new Error('Operation error evidence is already finalized.');
    if(this.seen.has(error))return;
    if(!errorPhases.includes(phase))throw new Error('Invalid diagnostic phase.');
    const id=randomUUID();this.write(`error-${id}.json`,{kind:'error',id,phase,...(this.wrappedClassification.get(error)??classification(error))});
    this.seen.add(error);this.errors++;
    for(const sibling of this.concurrent.get(error)??[])this.record(sibling,phase);
  }
  child(role:Role,env:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
    if(this.finished||!roles.includes(role))throw new Error('Invalid diagnostic child.');
    const id=randomUUID();this.write(`child-${id}.json`,{kind:'child',id,childRole:role});this.children++;
    return {...env,LAW_DIAGNOSTIC_TRACE_ID:this.traceId,LAW_DIAGNOSTIC_PROCESS_ID:id,LAW_DIAGNOSTIC_PARENT_ID:this.processId};
  }
  finish(status:'PASS'|'FAIL'){
    if(this.finished)throw new Error('Operation error evidence is already finalized.');
    this.write('completed.json',{kind:'completed',status:this.errors?'FAIL':status,errors:this.errors,children:this.children});
    this.finished=true;
  }
}

export function setErrorPhase(phase:Phase){const state=local.getStore();if(state)state.phase=phase;}
// Record only if this failed pool escapes to a monitored boundary. A rejected
// optional cache/checkpoint that is subsequently rebuilt is not a fatal error.
export function rememberConcurrentFailures(errors:unknown[]){local.getStore()?.registry.rememberConcurrent(errors);}
// Contextual wrappers represent the same first failure. Transfer only its
// drained siblings; do not count the original and wrapper as separate errors
// or turn a subsequently handled planning failure into a terminal event.
export function preserveWrappedFailure<T>(original:unknown,wrapped:T):T{
  local.getStore()?.registry.preserveWrappedFailure(original,wrapped);return wrapped;
}
export function bindErrorContext(env:NodeJS.ProcessEnv){local.getStore()?.registry.bind(env);}
export function diagnosticChildEnvironment(role:Role,env:NodeJS.ProcessEnv){return local.getStore()?.registry.child(role,env)??env;}
export function errorRegistryReference(){const r=local.getStore()?.registry;return r?{profile,traceId:r.traceId,
  processId:r.processId,directory:'.source-diagnostics/errors',status:'SEPARATE_PROCESS_EVIDENCE'}:null;}
export async function inErrorPhase<T>(phase:Phase,operation:()=>Promise<T>|T):Promise<T>{
  const state=local.getStore();if(!state)return operation();
  return local.run({...state,phase},async()=>{try{return await operation();}
    catch(error){state.registry.record(error,local.getStore()!.phase);throw error;}});
}
export async function withOperationErrors(role:Role,root:string,operation:()=>Promise<void>,env=process.env){
  const directory=path.join(root,'.source-diagnostics','errors'),registry=new OperationErrors(directory,role,env);
  return local.run({registry,phase:'CONFIGURATION'},async()=>{
    let failed=false;
    try{await operation();}
    catch(error){failed=true;registry.record(error,local.getStore()!.phase);throw error;}
    finally{
      try{
        registry.finish(failed||Number(process.exitCode??0)!==0?'FAIL':'PASS');
        if(registry.parentId===null){
          const summary=collectOperationErrors(directory,registry.traceId);
          if(!safeCacheDirectory(directory))throw new Error('Unsafe error summary directory.');
          fs.writeFileSync(path.join(directory,`summary-${registry.traceId}.json`),JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});
          if(summary.status!=='PASS'&&!failed)throw new Error('Operation diagnostics recorded an unsuccessful process tree.');
        }
      }
      catch(error){if(!failed)throw error;console.error('Operation error evidence finalization failed.');}
    }
  });
}

/** Read one explicit trace; never infer success from absent/killed children. */
export function collectOperationErrors(directory:string,traceId:string){
  if(!uuid.test(traceId)||!safeCacheDirectory(path.join(directory,traceId)))throw new Error('Invalid error evidence directory.');
  const root=path.join(directory,traceId),processes=new Map<string,any>(),events:any[]=[];
  for(const id of fs.readdirSync(root)){
    const dir=path.join(root,id);if(!uuid.test(id)||!safeCacheDirectory(dir))throw new Error('Invalid error evidence process.');
    const files=fs.readdirSync(dir),records:any[]=[];
    for(const name of files){
      const file=path.join(dir,name),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.size>1_000_000)throw new Error('Invalid error evidence file.');
      const r=JSON.parse(fs.readFileSync(file,'utf8'));
      const expected=r.kind==='started'?'started.json':r.kind==='completed'?'completed.json':
        ['child','error'].includes(r.kind)&&uuid.test(r.id??'')?`${r.kind}-${r.id}.json`:null;
      if(name!==expected||r.profile!==profile||r.traceId!==traceId||r.processId!==id||!roles.includes(r.role)||
        r.parentId!==null&&!uuid.test(r.parentId??''))throw new Error('Conflicting error evidence identity.');
      records.push(r);
    }
    const start=records.find(r=>r.kind==='started'),end=records.find(r=>r.kind==='completed');
    const errors=records.filter(r=>r.kind==='error'),children=records.filter(r=>r.kind==='child');
    if(!start||records.some(r=>r.role!==start.role||r.parentId!==start.parentId)||
      end&&(!['PASS','FAIL'].includes(end.status)||end.errors!==errors.length||end.children!==children.length||end.status==='PASS'&&errors.length)||
      errors.some(r=>!errorPhases.includes(r.phase)||!safeCodes.includes(r.code)||
        r.httpStatus!==null&&(!Number.isInteger(r.httpStatus)||r.httpStatus<100||r.httpStatus>599))||
      children.some(r=>!roles.includes(r.childRole)))
      throw new Error('Incomplete or conflicting error evidence records.');
    processes.set(id,{start,end,children});
    // Project only validated fields; never echo arbitrary values from imported evidence.
    events.push(...errors.map(r=>({id:r.id,processId:id,role:r.role,phase:r.phase,code:r.code,httpStatus:r.httpStatus,context:projectedContext(r.context)})));
  }
  const roots=[...processes.values()].filter(p=>p.start.parentId===null);
  if(roots.length!==1)throw new Error('Error trace requires exactly one root.');
  const visited=new Set<string>(),incomplete:string[]=[];
  const visit=(id:string,parent:string|null,role:Role)=>{
    if(visited.has(id))throw new Error('Repeated diagnostic child.');visited.add(id);
    const p=processes.get(id);if(!p){incomplete.push(id);return;}
    if(p.start.parentId!==parent||p.start.role!==role)throw new Error('Diagnostic child identity mismatch.');
    if(!p.end)incomplete.push(id);
    for(const child of p.children)visit(child.id,id,child.childRole);
  };
  visit(roots[0].start.processId,null,roots[0].start.role);
  if([...processes.keys()].some(id=>!visited.has(id)))throw new Error('Undeclared diagnostic process.');
  const complete=incomplete.length===0;
  return {profile:'operation-error-summary-v1',traceId,complete,
    status:!complete?'INCOMPLETE':events.length||[...processes.values()].some(p=>p.end.status==='FAIL')?'FAIL':'PASS',
    observedFailures:events.filter(e=>e.code!=='CHILD_PROCESS_FAILED').length,
    propagatedChildFailures:events.filter(e=>e.code==='CHILD_PROCESS_FAILED').length,
    incompleteProcesses:incomplete,events,processes:[...processes.values()].map(p=>({processId:p.start.processId,
      parentId:p.start.parentId,role:p.start.role,status:p.end?.status??'INCOMPLETE',context:projectedContext((p.end??p.start).context)})),
    scope:'Observed terminal failures of declared processes; propagation is separate. Not unknown source counts, retry counts, or proof of production publication.'};
}
