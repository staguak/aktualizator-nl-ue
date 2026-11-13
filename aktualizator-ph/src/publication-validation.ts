import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateV2 } from './output-validation.js';

import { loadValidatedFiles, loadValidatedSnapshot, verifiedFileMetadata, verifyFileBytes } from './validation-context.js';
import type { ValidationContext, ExpectedAct } from './validation-context.js';
import { validateLegacyContent } from './legacy-validation.js';
import type { FileMetadata as OutputFile } from './final-file.js';
import { CONTROL_FILES, writeControlFile } from './final-file.js';
import type { ValidationResult } from './validation-result.js';
import { isCalendarDate as calendarDate } from './calendar.js';
import { pendingValidation, requireReportStatus } from './validation-result.js';
import {sourceAuditMode} from './source-audit.js';
import type {SourceAuditMode} from './source-audit.js';
interface RemoteFile {
  id?: string | null;
  name?: string | null;
  size?: string | null;
  md5Checksum?: string | null;
  parents?: string[] | null;
}

export function validateOutput(dir: string, expectedActs: ExpectedAct[]): OutputFile[] {
  const context = loadValidatedFiles(dir, expectedActs);
  validateContext(context);
  return verifiedFileMetadata(context);
}
function validateContext(context: ValidationContext, allowPendingReport = false): void {
  if (context.manifest.schemaVersion === 2) validateV2(context);
  else if (context.manifest.validationVersion === 1) validateLegacyContent(context);
  if (context.manifest.schemaVersion === 2) requireReportStatus(context.text('REPORT.md'),allowPendingReport?'PENDING':'PASS');
}

export function completeBuiltOutput(dir: string, expectedActs: ExpectedAct[], renderReport: (result: ValidationResult) => string): OutputFile[] {
  const pending = pendingValidation();
  let jurisdiction: 'NL' | 'EU' = expectedActs[0]?.bwbId ? 'NL' : 'EU';
  writeControlFile(dir, jurisdiction, 'REPORT.md', renderReport(pending));
  try {
    const context = loadValidatedFiles(dir, expectedActs,sourceAuditMode());
    if (context.manifest.schemaVersion !== 2 || !['NL', 'EU'].includes(context.manifest.jurisdiction)) throw new Error('Only v2 builds can be finalized.');
    jurisdiction = context.manifest.jurisdiction;
    validateContext(context, true);
    const content = [...context.files.values()].filter(f => !CONTROL_FILES.includes(f.name));
    const result: ValidationResult = {status:'PASS',fileCount:context.files.size,contentFileCount:content.length,
      contentBytes:content.reduce((n,f)=>n+f.size,0),...context.sourceStructure?{sourceStructure:context.sourceStructure,sourceAvailability:context.sourceAvailability}:{},checks:['kompletność zestawu','UTF-8/LF','finalne MD5/size',
        ...(context.manifest.officialSources?['oryginalne bajty ZIP','katalog i MD5 każdego źródła']:[]),
        ...(jurisdiction==='NL' ? ['artykuły i wersje','stany źródłowe','treść prawna','przypisy','INDEX']
          : ['treść prawna i obrazy','metadane','części dokumentów','nawigacja','UE-REF bez łańcuchów','INDEX'])]};
    // Only REPORT changes after the full corpus check. Independently read and
    // verify its final bytes; avoid repeating every legal-content validation.
    const generated = writeControlFile(dir, jurisdiction, 'REPORT.md', renderReport(result));
    const report = verifyFileBytes('REPORT.md', fs.readFileSync(path.join(dir, 'REPORT.md')));
    if (generated.md5 !== report.md5 || generated.size !== report.size) throw new Error('Invalid finalized validation report.');
    requireReportStatus(report.text,'PASS');
    context.files.set('REPORT.md', report);
    return verifiedFileMetadata(context);
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'końcowa kontrola odrzuciła zestaw').replace(/\s+/g,' ').slice(0,300);
    writeControlFile(dir, jurisdiction, 'REPORT.md', renderReport({...pending,status:'FAIL',error:message}));
    throw error;
  }
}

type SnapshotTarget={jurisdiction:'NL'|'EU';files:Map<string,Buffer>;acts:ExpectedAct[]};
type PublicationTarget={jurisdiction:'NL'|'EU';acts:ExpectedAct[]}&({dir:string}|{files:Map<string,Buffer>});
function validatePublicationContexts(targets:PublicationTarget[], options: {requireV2?: boolean;auditMode?:SourceAuditMode} = {}): Map<string,ValidationContext> {
  if (targets.length !== 2 || new Set(targets.map((target) => target.jurisdiction)).size !== 2) {
    throw new Error('Both NL and EU corpora must be validated together.');
  }
  let range: string | undefined;
  const outputs=new Map<string,ValidationContext>();
  for (const target of targets) {
    const context = 'files' in target?loadValidatedSnapshot(target.files,target.acts,options.auditMode):loadValidatedFiles(target.dir, target.acts,options.auditMode);
    if (options.requireV2 && (context.manifest.schemaVersion !== 2 || context.manifest.validationVersion !== 2)) throw new Error('Only final v2 corpora can be synchronized.');
    validateContext(context);
    outputs.set(target.jurisdiction,context);
    const manifest = context.manifest;
    if (![1,2].includes(manifest.validationVersion) || manifest.jurisdiction !== target.jurisdiction ||
        !calendarDate(manifest.rangeFrom) || !calendarDate(manifest.rangeTo) ||
        manifest.rangeFrom > manifest.rangeTo) throw new Error('Missing content validation or invalid publication range.');
    const current = `${manifest.rangeFrom}/${manifest.rangeTo}`;
    if (range && range !== current) throw new Error('NL and EU publication dates differ.');
    range = current;
  }
  return outputs;
}

type PublicationTargets={jurisdiction:'NL'|'EU';dir:string;acts:ExpectedAct[]}[];
export function validatePublicationSet(targets:PublicationTargets,options:{requireV2?:boolean}={}):Map<string,OutputFile[]>{
  return new Map([...validatePublicationContexts(targets.map(({jurisdiction,dir,acts})=>({jurisdiction,dir,acts})),options)].map(([jurisdiction,context])=>[jurisdiction,verifiedFileMetadata(context)]));
}
export function validatedPublicationBytes(targets:PublicationTargets):Map<'NL'|'EU',Map<string,Buffer>>{
  return new Map([...validatePublicationContexts(targets.map(({jurisdiction,dir,acts})=>({jurisdiction,dir,acts})),{requireV2:true,auditMode:sourceAuditMode()})].map(([jurisdiction,context])=>
    [jurisdiction as 'NL'|'EU',new Map([...context.files].map(([name,file])=>[name,file.bytes]))]));
}
export function validatedPublicationSnapshot(targets:SnapshotTarget[]):Map<'NL'|'EU',Map<string,Buffer>>{
  return new Map([...validatePublicationContexts(targets.map(({jurisdiction,files,acts})=>({jurisdiction,files,acts})),{requireV2:true,auditMode:sourceAuditMode()})].map(([jurisdiction,context])=>
    [jurisdiction as 'NL'|'EU',new Map([...context.files].map(([name,file])=>[name,file.bytes]))]));
}

export function verifyRemoteFiles(local: OutputFile[], remote: RemoteFile[], folderId: string): void {
  if (remote.length !== local.length) throw new Error('Remote file count differs from output.');
  const byName = new Map(remote.map((file) => [file.name, file]));
  if (byName.size !== remote.length) throw new Error('Duplicate remote file names.');
  for (const file of local) {
    const found = byName.get(file.name);
    if (!found?.id || !found.parents?.includes(folderId) || found.md5Checksum !== file.md5
        || found.size !== String(file.size)) {
      throw new Error('Remote file metadata differs from output.');
    }
  }
}
