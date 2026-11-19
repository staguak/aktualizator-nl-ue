import fs from 'node:fs';
import path from 'node:path';
import type {EuBuiltAct} from './eu-model.js';
import type {EuAct} from './eu-provider.js';
import {safeArchiveName,loadSourceArchive} from './official-sources.js';
import {hash} from './release-store.js';
import {assertEuIntegrity} from './content-integrity.js';
import {assertEuCaseCoverage,assertEuCaseSource} from './eu-case-scope.js';
import {verifyEuLegalCheckpoint,euHeaderFromOriginal} from './eu-legal-verification.js';
import {assertMissingEuEvidence,missingEuDocuments} from './eu-unavailable.js';

// Partial attempts remain auditable on disk, but their gaps must be retried
// rather than becoming permanently completed checkpoints on the next resume.
export function reusableEuCheckpointActs<T extends {missingDocuments?:unknown[];discoveryIncomplete?:boolean}>(acts:T[]):T[]{
  return acts.filter(a=>!a.discoveryIncomplete&&!a.missingDocuments?.length);
}
/** Explicit offline migration; validate the entire old source/body snapshot
 * before the returned in-memory upgrade is accepted. Never overwrite a header. */
export function upgradeEuCheckpointHeaders(dir:string,acts:EuBuiltAct[],scope:EuAct[]):EuBuiltAct[]{
  const upgraded=structuredClone(acts);
  for(const act of upgraded){
    const configured=scope.find(a=>a.celex===act.celex);if(configured)act.title=configured.title;
    if(!act.sourceArchive||!safeArchiveName(act.sourceArchive.name))throw new Error('Invalid EU checkpoint archive name.');
    const file=path.join(dir,act.sourceArchive.name);
    if(!fs.lstatSync(file).isFile())throw new Error('EU checkpoint requires regular files only.');
    const native=loadSourceArchive(fs.readFileSync(file),act.sourceArchive,'EU',act.celex);
    for(const doc of act.documents)if(doc.legalDraft&&!doc.header)doc.header=euHeaderFromOriginal(doc,native.index,native.items);
  }
  readEuCheckpointFiles(dir,upgraded,scope);
  return upgraded;
}

// Return the exact verified bytes. Finalization must not reopen mutable paths
// after validating them or follow symlinks to files outside the checkpoint.
export function readEuCheckpointFiles(dir:string,acts:EuBuiltAct[],scope:EuAct[]):Map<string,Buffer>{
  if(!Array.isArray(acts)||!fs.lstatSync(dir).isDirectory())throw new Error('Invalid EU checkpoint directory or acts.');
  const files=new Map<string,Buffer>(),seen=new Set<string>();
  const read=(name:string)=>{
    if(files.has(name))throw new Error('Duplicate EU checkpoint file.');
    const file=path.join(dir,name);
    if(!fs.lstatSync(file).isFile())throw new Error('EU checkpoint requires regular files only.');
    const bytes=fs.readFileSync(file);files.set(name,bytes);return bytes;
  };
  for(const act of acts){
    const expected=scope.find(a=>a.celex===act.celex);
    if(!expected||expected.order!==act.order||seen.has(act.celex))throw new Error('EU checkpoint act differs from scope.');
    seen.add(act.celex);
    assertEuCaseCoverage(act,expected);
    if(!act.sourceArchive||!safeArchiveName(act.sourceArchive.name))throw new Error('Invalid EU checkpoint archive name.');
    const native=loadSourceArchive(read(act.sourceArchive.name),act.sourceArchive,'EU',act.celex);
    assertEuCaseSource(act,native.index,native.items,native.index.range.to);
    assertMissingEuEvidence(act,native.index,native.items);
    const missing=missingEuDocuments(act);
    const skipped=act.excludedDocuments?.some(row=>row.reason==='SKIPPED_UNSUPPORTED_LANGUAGE');
    if(!Array.isArray(act.files)||!act.files.length&&!missing.length&&!skipped||!Array.isArray(act.documents)||!act.documents.length&&!missing.length&&!skipped||
      new Set(act.documents.map(d=>d.celex)).size!==act.documents.length)throw new Error('Invalid EU checkpoint documents.');
    const texts=new Map<string,string>();
    for(const file of act.files){
      if(!/^[A-Za-z0-9_.-]+\.md$/.test(file.name)||['INDEX.md','REPORT.md'].includes(file.name)||
        !Number.isSafeInteger(file.part)||file.part<1||!act.documents.some(d=>d.celex===file.celex))
        throw new Error('Invalid EU checkpoint content identity.');
      const bytes=read(file.name);
      if(hash(bytes,'md5')!==file.md5)throw new Error('EU checkpoint file checksum mismatch.');
      texts.set(file.name,new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    }
    for(const doc of act.documents){
      const parts=act.files.filter(f=>f.celex===doc.celex).sort((a,b)=>a.part-b.part);
      if(!parts.length||parts.some((f,i)=>f.part!==i+1))throw new Error('Incomplete EU checkpoint document parts.');
      if(expected.outputProfile==='legal-structure-v1'&&!doc.legalDraft)throw new Error('EU checkpoint lacks configured legal structure.');
      if(doc.legalDraft)verifyEuLegalCheckpoint(doc,native.index,native.items,parts.map(f=>f.name),parts.map(f=>texts.get(f.name)!));
      assertEuIntegrity(doc.integrity,parts.map(f=>texts.get(f.name)!).join(doc.legalDraft?'':'\n'));
    }
  }
  return files;
}
