import fs from 'node:fs';
import path from 'node:path';
import {preflight,validateManifest} from './release-engine.js';
import {hash,encode} from './release-store.js';
import type {ReleaseStore} from './release-store.js';
import {runPool} from './concurrency.js';
import {isDeepStrictEqual} from 'node:util';

// Read-only extraction for independent acceptance of the actual immutable base.
// No fresh source fetch or replacement of an existing Drive object is allowed.
export async function exportBaseEvidence(store:ReleaseStore,directory:string,includeCheckpointEvidence=false){
  for(let current=path.resolve(directory);;current=path.dirname(current)){
    try{if(!fs.lstatSync(current).isDirectory())throw new Error('Base diagnostic directory symlink or non-directory refused.');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(current===path.dirname(current))break;
  }
  const readonly:ReleaseStore={read:store.read.bind(store),stat:store.stat.bind(store),list:store.list.bind(store),
    async write(){throw new Error('Base diagnostics cannot write Drive.');},async remove(){throw new Error('Base diagnostics cannot remove Drive data.');}};
  const active=await preflight(readonly,'update',false);
  if(!active)throw new Error('A committed paired release is required for base evidence.');
  const key=`base/${active.baseId}/release.json`,bytes=await readonly.read(key);
  if(!bytes||hash(bytes)!==active.baseManifestSha256)throw new Error('Base evidence anchor mismatch.');
  const base:unknown=JSON.parse(bytes.toString('utf8'));validateManifest(base);
  if(base.kind!=='base'||base.context.baseId!==active.baseId)throw new Error('Unexpected base evidence identity.');
  const data=new Map<string,Buffer>();
  await runPool(base.files,4,async reference=>{
    const [raw,metadata]=await Promise.all([readonly.read(reference.key),readonly.stat(reference.key)]);
    if(!raw||!metadata||metadata.id!==reference.id||metadata.size!==reference.size||
      metadata.sha256!==reference.sha256||metadata.md5!==reference.md5||raw.length!==reference.size||
      hash(raw)!==reference.sha256||hash(raw,'md5')!==reference.md5)throw new Error('Base diagnostic file checksum/identity mismatch.');
    data.set(reference.key,raw);
  });
  const checkpointEvidence:{key:string;sha256:string;bytes:Buffer}[]=[];
  if(includeCheckpointEvidence){
    for(const prefix of ['checks/faults/','checks/resumes/']){
      const keys=await readonly.list(prefix);
      if(keys.length>1000)throw new Error('Checkpoint evidence inventory limit exceeded.');
      for(const receiptKey of keys.sort()){
        if(receiptKey===`${prefix}.ready.json`)continue;
        if(!receiptKey.startsWith(prefix)||!/^[-A-Za-z0-9_]+\.json$/.test(receiptKey.slice(prefix.length)))
          throw new Error('Unsafe checkpoint evidence key.');
        const [raw,metadata]=await Promise.all([readonly.read(receiptKey),readonly.stat(receiptKey)]);
        if(!raw||!metadata||raw.length>2_000_000||metadata.size!==raw.length||
          metadata.sha256!==hash(raw)||metadata.md5!==hash(raw,'md5'))throw new Error('Checkpoint evidence checksum mismatch.');
        const event=JSON.parse(raw.toString('utf8'));
        // Keep the exact receipt; the independent verifier decides whether it
        // proves interruption/reuse. Other operations are deliberately excluded.
        if(event.context?.runId!==base.context.runId)continue;
        if(event.context?.releaseId!==base.context.releaseId||event.context?.codeRevision!==base.context.codeRevision||
          event.context?.configSha256!==base.context.configSha256)throw new Error('Checkpoint evidence context mismatch.');
        checkpointEvidence.push({key:receiptKey,sha256:hash(raw),bytes:raw});
      }
    }
  }
  const pointer=await readonly.read('active.json');
  if(!pointer||!isDeepStrictEqual(JSON.parse(pointer.toString('utf8')),active))throw new Error('Active operation changed during base export.');
  fs.mkdirSync(directory,{recursive:true});
  if(!fs.lstatSync(directory).isDirectory())throw new Error('Base diagnostics require a regular directory.');
  const write=(folder:string,name:string,raw:Buffer)=>{
    if(!/^[A-Za-z0-9_.-]+$/.test(name))throw new Error('Unsafe base diagnostic file name.');
    fs.mkdirSync(folder,{recursive:true});if(!fs.lstatSync(folder).isDirectory())throw new Error('Base diagnostic symlink refused.');
    const file=path.join(folder,name);
    try{fs.writeFileSync(file,raw,{flag:'wx'});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(!fs.lstatSync(file).isFile()||!fs.readFileSync(file).equals(raw))throw new Error('Conflicting base diagnostic evidence.');}
  };
  for(const file of base.files)write(path.join(directory,file.jurisdiction),file.name,data.get(file.key)!);
  write(directory,'generation.json',bytes);write(directory,'active.json',pointer);
  if(includeCheckpointEvidence){
    for(const receipt of checkpointEvidence)write(path.join(directory,'checkpoints'),receipt.key.replaceAll('/','_'),receipt.bytes);
    write(directory,'checkpoint-evidence.json',encode({schemaVersion:1,scope:'Exact read-only receipts for this immutable base operation; independent validation required',
      runId:base.context.runId,records:checkpointEvidence.map(({key,sha256})=>({key,sha256,file:`checkpoints/${key.replaceAll('/','_')}`}))}));
  }
  const report={schemaVersion:1,status:'EXPORTED',scope:'Exact verified immutable base, not a production cutover',
    baseId:active.baseId,releaseId:active.releaseId,codeRevision:base.context.codeRevision,
    manifestSha256:hash(bytes),files:base.files.length,originalRangeStart:base.context.rangeFrom};
  write(directory,'export.json',encode(report));return report;
}
