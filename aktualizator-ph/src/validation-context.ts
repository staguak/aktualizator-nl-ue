import fs from 'node:fs';
import path from 'node:path';
import { fileMetadata, normalizeOutput, stableJson } from './output.js';
import { safeContentName, publishedMetadata, CONTROL_FILES } from './final-file.js';
import type { FileMetadata } from './final-file.js';
import type { ScopeInclude } from './types.js';
import { isCalendarDate } from './calendar.js';
import { safeArchiveName, validateSourceArchive } from './official-sources.js';
import {sourceStructure} from './source-structure.js';
import type {SourceStructure} from './source-structure.js';
import {sourceAvailability} from './source-availability.js';
import type {SourceAvailability} from './source-availability.js';
import {assertUnconditionalSourceObservations} from './source-audit.js';
import type {SourceAuditMode} from './source-audit.js';

export interface ExpectedAct {
  order: number; bwbId?: string; celex?: string;
  requiredVersions?: string[]; attachedDocuments?: {celex: string}[];
  include?: ScopeInclude | string; mustIncludeArticles?: string[];
}
export interface LoadedFile extends FileMetadata { bytes: Buffer; text: string }
export interface ValidationContext {
  manifest: any;
  expectedActs: ExpectedAct[];
  files: Map<string, LoadedFile>;
  sourceStructure?:SourceStructure;
  sourceAvailability?:SourceAvailability[];
  text(name: string): string;
}
export function loadValidatedFiles(dir: string, expectedActs: ExpectedAct[],auditMode?:SourceAuditMode): ValidationContext {
  const read = (name: string): Buffer => {
    const file = path.join(dir, name);
    if (!fs.lstatSync(file).isFile()) throw new Error('Output must contain regular files only.');
    return fs.readFileSync(file);
  };
  return loadValidationContext(read,()=>fs.readdirSync(dir).sort(),expectedActs,auditMode);
}
export function loadValidatedSnapshot(files:Map<string,Buffer>,expectedActs:ExpectedAct[],auditMode?:SourceAuditMode):ValidationContext {
  return loadValidationContext(name=>{
    const bytes=files.get(name);if(!Buffer.isBuffer(bytes))throw new Error('Snapshot file is missing or invalid.');return bytes;
  },()=>[...files.keys()].sort(),expectedActs,auditMode);
}
function loadValidationContext(read:(name:string)=>Buffer,list:()=>string[],expectedActs:ExpectedAct[],auditMode?:SourceAuditMode):ValidationContext {
  const manifestBytes = read('manifest.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.acts) ||
      manifest.acts.length !== expectedActs.length || !expectedActs.length) {
    throw new Error('Incomplete manifest or unsupported schema.');
  }
  if (manifest.schemaVersion === 2 && (!['NL','EU'].includes(manifest.jurisdiction) ||
      !isCalendarDate(manifest.rangeFrom) || !isCalendarDate(manifest.rangeTo) || manifest.rangeFrom > manifest.rangeTo)) {
    throw new Error('Invalid final corpus jurisdiction/date range.');
  }
  const declared = new Map<string, {md5?: string; size?: number}>(CONTROL_FILES.map(name => [name, {}]));
  const seenActs = new Set<string>();
  for (const act of manifest.acts) {
    const key = `${act.order}:${act.bwbId ?? act.celex}`;
    if (Boolean(act.bwbId) === Boolean(act.celex) || seenActs.has(key) || !expectedActs.some(item =>
      item.order === act.order && (item.bwbId ? item.bwbId === act.bwbId : item.celex === act.celex)) ||
      !Array.isArray(act.files) || !act.files.length) throw new Error('Missing, duplicate or unexpected act in manifest.');
    seenActs.add(key);
    if(manifest.officialSources&&!act.sourceArchive)throw new Error('Missing official source archive.');
    if(act.sourceArchive){
      const archive=act.sourceArchive;
      if(!safeArchiveName(archive.name)||declared.has(archive.name)||!Number.isSafeInteger(archive.size)||archive.size<=0||
        !/^[a-f0-9]{32}$/.test(archive.md5))throw new Error('Invalid official source archive declaration.');
      declared.set(archive.name,archive);
    }
    for (const file of act.files) {
      if (!safeContentName(file.name) || declared.has(file.name) || !/^[a-f0-9]{32}$/.test(file.md5) ||
          manifest.schemaVersion === 2 && (!Number.isSafeInteger(file.size) || file.size <= 0)) {
        throw new Error('Unsafe, duplicate or invalid manifest file.');
      }
      declared.set(file.name, file);
    }
  }
  const names = list();
  if (names.length !== declared.size || names.some(name => !declared.has(name))) throw new Error('Output file list differs from manifest.');
  const files = new Map<string, LoadedFile>();
  const structure:SourceStructure={snapshots:0,unitObservations:0,editorialCorrections:0,corrigendumSnapshots:0,alternateRepresentations:0};
  const availability:SourceAvailability[]=[];
  for (const name of names) {
    // An independent disk read verifies generated hashes; each file is read
    // only once in this validation, including the already loaded manifest.
    const bytes = name === 'manifest.json' ? manifestBytes : read(name);
    const expected = declared.get(name)!;
    let verified:LoadedFile;
    if(safeArchiveName(name)){
      const act=manifest.acts.find((a:any)=>a.sourceArchive?.name===name);
      const index=validateSourceArchive(bytes,act.sourceArchive,manifest.jurisdiction,act.bwbId??act.celex);
      if(auditMode==='unconditional')assertUnconditionalSourceObservations(index.entries);
      if(index.diagnosticOnly===true)throw new Error('Diagnostic-only source archive cannot be published.');
      const counts=sourceStructure(index);
      const assessment=sourceAvailability(index);
      if(assessment.issues.some(i=>i.classification==='CRITICAL'))throw new Error('Critical source issue blocks publication.');
      availability.push(assessment);
      for(const key of Object.keys(structure) as (keyof SourceStructure)[])structure[key]+=counts[key];
      if(index.range.from!==manifest.rangeFrom||index.range.to!==manifest.rangeTo)throw new Error('Official archive range differs from corpus.');
      verified={...fileMetadata(name,bytes),bytes,text:''};
    }else verified=verifyFileBytes(name, bytes, manifest.schemaVersion === 2);
    if (expected.md5 && expected.md5 !== verified.md5) throw new Error('Empty or corrupted output file.');
    if (manifest.schemaVersion === 2 && expected.size !== undefined && expected.size !== verified.size) throw new Error('Final size mismatch.');
    files.set(name, verified);
  }
  const text = (name: string): string => {
    const file = files.get(name);
    if (!file) throw new Error('Referenced output file is missing.');
    return file.text;
  };
  if (manifest.schemaVersion === 2 && text('manifest.json') !== stableJson(manifest)) throw new Error('Noncanonical manifest serialization.');
  return {manifest, expectedActs, files, text,...manifest.officialSources?{sourceStructure:structure,sourceAvailability:availability}:{}};
}
export function verifyFileBytes(name: string, bytes: Buffer, strict = true): LoadedFile {
  if (!bytes.length) throw new Error('Empty or corrupted output file.');
  const text = strict ? new TextDecoder('utf-8', {fatal: true}).decode(bytes) : bytes.toString('utf8');
  if (strict && (Buffer.compare(Buffer.from(text, 'utf8'), bytes) !== 0 || text !== normalizeOutput(text))) {
    throw new Error('Invalid final UTF-8/LF/whitespace.');
  }
  return {...fileMetadata(name, bytes), bytes, text};
}
export function verifiedFileMetadata(context: ValidationContext): FileMetadata[] {
  return [...context.files.values()].map(publishedMetadata);
}
