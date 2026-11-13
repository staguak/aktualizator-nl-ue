import fs from 'node:fs';
import path from 'node:path';
import type {ScopeConfig} from './types.js';
import type {NlActManifest} from './nl-output.js';
import {safeArchiveName,validateSourceArchive} from './official-sources.js';
import {safeContentName,CONTROL_FILES} from './final-file.js';
import {hash} from './release-store.js';
import {assertIntegrity,nlOutputIntegrity} from './content-integrity.js';

export function readNlCheckpointFiles(dir:string,acts:NlActManifest[],config:ScopeConfig):Map<string,Buffer>{
  if(!Array.isArray(acts)||!fs.lstatSync(dir).isDirectory())throw new Error('Invalid completed-act checkpoint directory.');
  const files=new Map<string,Buffer>(),seen=new Set<string>();
  const read=(name:string)=>{
    if(files.has(name))throw new Error('Duplicate checkpoint file.');
    const target=path.join(dir,name);
    if(!fs.lstatSync(target).isFile())throw new Error('Checkpoint must contain regular files only.');
    const bytes=fs.readFileSync(target);files.set(name,bytes);return bytes;
  };
  for(const act of acts){
    const expected=config.acts.find(a=>a.bwbId===act.bwbId);
    if(!expected||expected.order!==act.order||expected.title!==act.title||seen.has(act.bwbId))
      throw new Error('Checkpoint act differs from configured scope.');
    seen.add(act.bwbId);
    if(!act.sourceArchive||!safeArchiveName(act.sourceArchive.name))throw new Error('Invalid checkpoint source archive name.');
    validateSourceArchive(read(act.sourceArchive.name),act.sourceArchive,'NL',act.bwbId);
    if(!Array.isArray(act.files)||!act.files.length)throw new Error('Empty checkpoint act.');
    const texts=act.files.map(file=>{
      if(!safeContentName(file.name)||CONTROL_FILES.includes(file.name))throw new Error('Invalid checkpoint content name.');
      const bytes=read(file.name);
      if(hash(bytes,'md5')!==file.md5)throw new Error('Checkpoint file checksum mismatch.');
      return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    });
    assertIntegrity(act.integrity,nlOutputIntegrity(texts));
  }
  return files;
}
export function installCheckpointFiles(output:string,files:Map<string,Buffer>):void{
  const staged=fs.mkdtempSync(path.join(path.dirname(output),'.checkpoint-restore-'));
  try{
    for(const [name,bytes] of files)fs.writeFileSync(path.join(staged,name),bytes);
    fs.rmSync(output,{recursive:true,force:true});
    fs.renameSync(staged,output);
  }finally{fs.rmSync(staged,{recursive:true,force:true});}
}
