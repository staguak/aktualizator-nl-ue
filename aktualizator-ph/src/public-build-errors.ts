import fs from 'node:fs';
import path from 'node:path';
import {safeCacheDirectory} from './cache-directory.js';

export type PublicBuildStage='CONFIGURATION'|'MODULE_BUILD'|'OUTPUT_VALIDATION'|'INDEPENDENT_AUDIT'|'FREEZE';
export class PublicBuildError extends Error {
  constructor(readonly code:'PRIVATE_CREDENTIALS_FORBIDDEN'|'BUILD_ARGUMENT_INVALID'|'AUDIT_TIMEOUT'|'AUDIT_FAILED'|'AUDIT_OUTPUT_INVALID',
    readonly auditLine?:number){super(code);}
}
export function independentAuditError(stderr:string,timedOut=false):PublicBuildError{
  const lines=[...stderr.matchAll(/File "[^"\r\n]*verify_official_output\.py", line (\d+)/g)];
  const auditLine=Number(lines.at(-1)?.[1]);
  return new PublicBuildError(timedOut?'AUDIT_TIMEOUT':'AUDIT_FAILED',Number.isSafeInteger(auditLine)&&auditLine>0?auditLine:undefined);
}
export function recordPublicBuildFailure(root:string,error:unknown,stage:PublicBuildStage){
  const code=error instanceof PublicBuildError?error.code:
    stage==='MODULE_BUILD'?'MODULE_BUILD_FAILED':stage==='OUTPUT_VALIDATION'?'OUTPUT_VALIDATION_FAILED':
    stage==='CONFIGURATION'?'BUILD_CONFIGURATION_FAILED':'BUILD_FAILED';
  const record={code,stage,...error instanceof PublicBuildError&&error.auditLine?{auditLine:error.auditLine}:{}};
  const directory=path.join(root,'.public-control');
  if(!safeCacheDirectory(directory))throw new Error('Unsafe public diagnostics directory.');
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'build-error.json'),JSON.stringify(record)+'\n',{mode:0o600});
  console.error(`::error title=Public corpus build::${code}; etap=${stage}`+
    ('auditLine' in record?`; verify_official_output.py:${record.auditLine}`:''));
  return record;
}
