// A complete catalog review with conditional entities and an independent
// unconditional source/parser audit are distinct, explicitly named modes.
import {randomUUID} from 'node:crypto';
export type SourceAuditMode='conditional'|'unconditional';
export function sourceAuditMode(env:NodeJS.ProcessEnv=process.env):SourceAuditMode{
  const value=env.LAW_SOURCE_AUDIT??'conditional';
  if(value!=='conditional'&&value!=='unconditional')throw new Error('Invalid source audit mode; choose conditional or unconditional.');
  return value;
}
export function assertUnconditionalSourceObservations(entries:{httpObservation?:{status:number;method:string}}[]):void{
  if(!entries.length||entries.some(entry=>entry.httpObservation?.status!==200||entry.httpObservation.method!=='downloaded'))
    throw new Error('Unconditional source audit requires a complete set of actual downloaded body observations.');
}
export function sourceAuditIdentity(env:NodeJS.ProcessEnv=process.env):string|null{
  if(sourceAuditMode(env)!=='unconditional')return null;
  let id:string|undefined;
  if(env.LAW_RELEASE_CONTEXT){
    const context=JSON.parse(env.LAW_RELEASE_CONTEXT);
    if(context.sourceAudit!=='unconditional')throw new Error('Full audit cannot reuse a conditional paired processing context.');
    id=context.runId;
  }else{
    // A new standalone invocation is a new audit, even on the same day.
    // An explicitly supplied technical ID resumes that same earlier audit.
    id=env.LAW_SOURCE_AUDIT_ID??=randomUUID();
  }
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw new Error('Invalid technical source audit identity.');
  return id;
}
export function sourceAuditCheckpointTag(env:NodeJS.ProcessEnv=process.env){
  const id=sourceAuditIdentity(env);return id===null?'conditional':`unconditional:${id}`;
}
