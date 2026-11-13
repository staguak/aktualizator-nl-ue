import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {safeCacheDirectory} from './cache-directory.js';
import {sourceAuditMode,sourceAuditIdentity} from './source-audit.js';

const names=['sourceRequests','sourceReceivedEntityBytes','sourceNotModified','sourceCacheReusedBytes','sourceRetries',
  'parserComputed','parserCacheHits','actsBuilt','actsCheckpointReused','driveRetries',
  'driveUploadAttempts','driveSubmittedBytes','driveUploadedFiles','driveReusedFiles','driveReusedBytes'] as const;
type Counter=typeof names[number];
export class OperationMetrics {
  private values=Object.fromEntries(names.map(n=>[n,0])) as Record<Counter,number>;
  private unique=new Map<Counter,Set<string>>();
  private started:bigint;
  private transfers=new Map<number,bigint>();
  private transferId=0;private transferCalls=0;private transferUnionStarted=0n;
  private transferBusy=0n;private transferSum=0n;
  constructor(private clock:()=>bigint=()=>process.hrtime.bigint()){this.started=clock();}
  add(name:Counter,amount=1):void{
    if(!Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(this.values[name]+amount))throw new Error('Invalid metrics counter.');
    this.values[name]+=amount;
  }
  once(name:Counter,key:string):boolean{
    if(name==='driveUploadedFiles'||name==='driveReusedFiles')key=createHash('sha256').update(key).digest('hex');
    const seen=this.unique.get(name)??new Set<string>();if(seen.has(key))return false;
    seen.add(key);this.unique.set(name,seen);this.add(name);return true;
  }
  beginSourceTransfer():()=>void{
    const started=this.clock(),id=++this.transferId;
    if(!this.transfers.size)this.transferUnionStarted=started;
    this.transfers.set(id,started);this.transferCalls++;
    let ended=false;
    return ()=>{
      if(ended)return;ended=true;const now=this.clock();
      this.transferSum+=now-started;this.transfers.delete(id);
      if(!this.transfers.size)this.transferBusy+=now-this.transferUnionStarted;
    };
  }
  snapshot(){
    const now=this.clock();
    return {elapsedMs:Number(now-this.started)/1_000_000,counters:{...this.values},
      distinctStorageKeys:Object.fromEntries((['driveUploadedFiles','driveReusedFiles'] as const).map(name=>
        [name,[...this.unique.get(name)??[]].sort()])),
      sourceStage:{calls:this.transferCalls,activeCalls:this.transfers.size,
        busyMs:Number(this.transferBusy+(this.transfers.size?now-this.transferUnionStarted:0n))/1_000_000,
        summedCallMs:Number(this.transferSum+[...this.transfers.values()].reduce((n,start)=>n+now-start,0n))/1_000_000,
        scope:'One process: union of overlapping source-fetch calls, including cache read/write and redirects; excludes parsing, rate-limit pauses and retry backoff. Summed call time is not wall time.'}};
  }
}
export const operationMetrics=new OperationMetrics();
let boundContext:{runId:string;releaseId:string;configSha256?:string;mode?:'initialize'|'update';sourceAudit?:'conditional'|'unconditional'}|undefined;
export function bindMetricsContext(context:{runId:string;releaseId:string;configSha256?:string;mode?:'initialize'|'update';sourceAudit?:'conditional'|'unconditional'}):void{
  boundContext={runId:context.runId,releaseId:context.releaseId,configSha256:context.configSha256,mode:context.mode,sourceAudit:context.sourceAudit};
}

export function persistMetrics(directory:string,role:'NL'|'EU'|'pair'|'release',status:'PASS'|'FAIL',
  collector=operationMetrics,env:NodeJS.ProcessEnv=process.env){
  let context:any;
  if(env.LAW_RELEASE_CONTEXT)context=JSON.parse(env.LAW_RELEASE_CONTEXT);
  const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value)?value:null;
  const record={schemaVersion:1,profile:'process-operation-metrics-v1',role,status,
    sourceAudit:sourceAuditMode(env),
    technicalSourceAuditId:sourceAuditIdentity(env),
    recordedAt:new Date().toISOString(),
    githubRunId:/^\d{1,20}$/.test(env.GITHUB_RUN_ID??'')?env.GITHUB_RUN_ID:null,
    githubRunAttempt:/^[1-9]\d{0,5}$/.test(env.GITHUB_RUN_ATTEMPT??'')?env.GITHUB_RUN_ATTEMPT:null,
    githubJob:/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(env.GITHUB_JOB??'')?env.GITHUB_JOB:null,
    phase:['base','release'].includes(env.LAW_RELEASE_PHASE??'')?env.LAW_RELEASE_PHASE:'standalone',
    runId:id(context?.runId),releaseId:id(context?.releaseId),
    configSha256:/^[a-f0-9]{64}$/.test(context?.configSha256??'')?context.configSha256:null,
    mode:['initialize','update'].includes(context?.mode)?context.mode:null,
    codeRevision:/^[a-f0-9]{40}$/.test(env.LAW_UPDATER_REVISION??'')?env.LAW_UPDATER_REVISION:null,
    ...collector.snapshot(),maxResidentBytes:process.resourceUsage().maxRSS*1024,
    measurement:{scope:'One process; child receipts must be correlated, not blindly summed for wall time.',
      sourceBytes:'Response entity chunks read after transport decompression, including rejected/partial bodies; not wire bytes.',
      uploadBytes:'Full payload bytes submitted per SDK attempt; not confirmed transmitted bytes.',
      retries:'Explicit source HTTP retries plus SRU semantic-page retries; Drive SDK retries counted separately. A first attempt or failed unused final retry is not an extra retry.',
      driveFiles:'Distinct logical storage keys written/reused per process; categories may overlap; includes controls and checkpoints.',
      distinctStorageKeys:'SHA256 of namespace/root/logical-key identities; union across matching processes for global file counts. No raw paths, source URLs or credentials.',
      actionsBilledMinutes:null,totalDriveStoredBytes:null,
      unknown:'Billing and complete retained-store usage require external job/inventory evidence; null is not zero.'}};
  if(!safeCacheDirectory(directory))throw new Error('Unsafe metrics evidence directory.');
  fs.mkdirSync(directory,{recursive:true});
  if(!safeCacheDirectory(directory))throw new Error('Unsafe metrics evidence directory.');
  fs.writeFileSync(path.join(directory,`${role}-${randomUUID()}.json`),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
  return record;
}

export function registerProcessMetrics(role:'NL'|'EU'|'pair'|'release'):void{
  const directory=process.env.LAW_METRICS_DIR;if(!directory)return;
  // Synchronous exit persistence also runs after handled build failures. A
  // killed process can lack a receipt; absence never certifies success.
  process.once('exit',()=>{
    try{const env=boundContext?{...process.env,LAW_RELEASE_CONTEXT:JSON.stringify(boundContext)}:process.env;
      const record=persistMetrics(directory,role,Number(process.exitCode??0)!==0?'FAIL':'PASS',operationMetrics,env);
      console.log(JSON.stringify({metricsProfile:record.profile,role,status:record.status,elapsedMs:record.elapsedMs,
        counters:record.counters,sourceStage:record.sourceStage}));}
    catch{console.error('Metrics evidence persistence failed.');process.exitCode=1;}
  });
}
