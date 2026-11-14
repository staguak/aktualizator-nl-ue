import {zipSync} from 'fflate';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {createHash} from 'node:crypto';
import {fileDigests} from './source-cache.js';
import type {BinarySource} from './source-cache.js';
import type {FileMetadata} from './final-file.js';
import {fileMetadata,stableJson,stableCompactJson} from './output.js';
import {observeUnits,linkOfficialUnitObservations,correlateWtiUnits} from './unit-observations.js';
import type {UnitSnapshot} from './unit-observations.js';
import {encodeUnitMetadata,decodeUnitMetadata} from './unit-encoding.js';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateSourceIssues,sourceAvailability} from './source-availability.js';
import type {SourceIssue} from './source-availability.js';
import {safeCacheDirectory} from './cache-directory.js';
import {sourceReportEvidence} from './source-report-evidence.js';
import type {SourceReportEvidence} from './source-report-evidence.js';
import {isDeepStrictEqual} from 'node:util';
import {zipInventory,decodeZipPayloads} from './zip-integrity.js';

export interface SourceArchive extends FileMetadata {entryCount:number;warnings:string[];model:'BWB'|'CELLAR';catalogFormat?:'canonical-compact-json-v1';sourceIssueProfile?:'source-issues-v1';reportEvidence?:SourceReportEvidence;diagnosticOnly?:true;distribution?:{bundle:string;prefix:string}}
interface SourceEntry {name:string;size:number;md5:string;sha256?:string;requestedUrl:string;url:string;contentType:string;kind:string;metadata:unknown;httpObservation?:BinarySource['observation'];cacheHint?:BinarySource['cacheHint']}
const checksum=(b:Uint8Array)=>createHash('md5').update(b).digest('hex');
const safePath=(n:string)=>/^[A-Za-z0-9_.\/-]+$/.test(n)&&!n.split('/').some(p=>!p||p==='.'||p==='..');
export const safeArchiveName=(n:unknown):n is string=>typeof n==='string'&&/^\d+_[A-Za-z0-9_.-]+\.sources\.zip$/.test(n);
export function sourceArchiveName(order:number,identifier:string):string {
  if(!Number.isSafeInteger(order)||order<0||!identifier)throw new Error('Invalid source archive identity.');
  return `${String(order).padStart(2,'0')}_${identifier.replace(/[^A-Za-z0-9_.-]/g,'_')}.sources.zip`;
}
export function xmlObject(bytes:Uint8Array):any {
  const xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(XMLValidator.validate(xml)!==true)throw new Error('Invalid official XML.');
  return new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',removeNSPrefix:true,parseTagValue:false,parseAttributeValue:false}).parse(xml);
}
export class OfficialSources {
  private entries=new Map<string,{entry:SourceEntry;bytes?:Buffer;filePath?:string}>();
  private discovery:Record<string,unknown>|undefined;
  readonly warnings:string[]=[];
  private sourceIssues:SourceIssue[]=[];
  private unclassifiedWarnings=new Set<string>();
  constructor(readonly jurisdiction:'NL'|'EU',readonly identifier:string,readonly range:{from:string;to:string;observedOn:string}){}
  add(name:string,source:BinarySource,requestedUrl:string,kind:string,metadata:unknown=null):void {
    const native=source.filePath?{...fileDigests(source.filePath),filePath:source.filePath}:{bytes:source.bytes,size:source.bytes.length,md5:checksum(source.bytes),sha256:createHash('sha256').update(source.bytes).digest('hex')};
    if(source.sha256!==undefined&&source.sha256!==native.sha256)throw new Error('Original source checksum differs from downloaded bytes.');
    if(!safePath(name)||name==='manifest.json'||!native.size)throw new Error('Unsafe official source entry.');
    const entry:SourceEntry={name,size:native.size,md5:native.md5,sha256:native.sha256,requestedUrl,url:source.url,contentType:source.contentType,kind,metadata,
      ...source.observation?{httpObservation:source.observation}:{},...source.cacheHint?{cacheHint:source.cacheHint}:{}};
    const old=this.entries.get(name);
    if(old&&old.entry.md5!==entry.md5)throw new Error('Official source changed within one build.');
    if(old&&stableJson(old.entry)!==stableJson(entry))throw new Error('Conflicting source observations require distinct archive entries.');
    this.entries.set(name,{entry,...'filePath' in native?{filePath:native.filePath}:{bytes:native.bytes}});
  }
  warning(message:string,issue?:Omit<SourceIssue,'message'>):void {
    if(!issue){if(!this.warnings.includes(message))this.warnings.push(message);this.unclassifiedWarnings.add(message);return;}
    const record={...issue,message};validateSourceIssues([record],[message]);
    if(!this.warnings.includes(message))this.warnings.push(message);
    if(!this.sourceIssues.some(i=>stableJson(i)===stableJson(record)))this.sourceIssues.push(record);
  }
  completeDiscovery(evidence:Record<string,unknown>):void{
    if(this.discovery&&stableJson(this.discovery)!==stableJson(evidence))throw new Error('Conflicting source discovery completion.');
    this.discovery=evidence;
  }
  preserveDiagnostic(code:'NL_SELECTION_FAILED'|'NL_DISCOVERY_FAILED'|'EU_DISCOVERY_FAILED'|'EU_SOURCE_FAILED'):void{
    if(!code.startsWith(this.jurisdiction+'_'))throw new Error('Source diagnostic jurisdiction mismatch.');
    // A failed selector must retain the pages it actually saw, even though no
    // completed act/checkpoint can be published. Never substitute a later fetch.
    const dir=process.env.LAW_XML_DIAGNOSTICS_DIR??path.join(process.cwd(),'.source-diagnostics');
    const native=this.entries.size?this.build(sourceArchiveName(0,this.identifier),{diagnosticOnly:true}):null;
    const digest=native?createHash('sha256').update(native.bytes).digest('hex'):null;
    const status=this.jurisdiction==='NL'?'INCOMPLETE_SOURCE_SELECTION':code==='EU_DISCOVERY_FAILED'?'INCOMPLETE_SOURCE_DISCOVERY':'INCOMPLETE_SOURCE_PROCESSING';
    const record=Buffer.from(stableJson({schemaVersion:1,status,code,
      jurisdiction:this.jurisdiction,identifier:this.identifier,range:this.range,
      sourceIssueProfile:'source-issues-v1',sourceIssues:[{classification:'CRITICAL',code,documentId:this.identifier,
        message:'Required source discovery/selection/processing did not complete; available original responses retained.'}],
      archive:native?{...native.metadata,file:digest+'.zip',sha256:digest}:null,
      scope:'Diagnostic original observations only; not a validated or publishable corpus.'}));
    const write=(name:string,bytes:Buffer)=>{
      const file=path.join(dir,name);
      try{fs.writeFileSync(file,bytes,{flag:'wx'});}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        if(!fs.lstatSync(file).isFile()||!fs.readFileSync(file).equals(bytes))throw new Error('Conflicting source diagnostics.');}
    };
    try{if(!safeCacheDirectory(dir))throw new Error('Unsafe diagnostics directory.');
      fs.mkdirSync(dir,{recursive:true});if(!safeCacheDirectory(dir))throw new Error('Unsafe diagnostics directory.');
      if(native)write(digest+'.zip',native.bytes);
      write(createHash('sha256').update(record).digest('hex')+'.selection.json',record);}
    catch{throw new Error('Source-selection evidence persistence failed.');}
  }
  build(name:string,options:{diagnosticOnly?:boolean}={}):{metadata:SourceArchive;bytes:Buffer} {
    if(!safeArchiveName(name))throw new Error(`Unsafe official sources archive name: ${name}`);
    if(!this.entries.size)throw new Error('Empty official sources archive.');
    if(this.unclassifiedWarnings.size&&this.sourceIssues.length)throw new Error('Cannot mix typed and unclassified source issues.');
    const issueFields=this.unclassifiedWarnings.size?{}:{sourceIssueProfile:'source-issues-v1' as const,
      sourceIssues:[...this.sourceIssues].sort((a,b)=>stableJson(a).localeCompare(stableJson(b),'en'))};
    const entries=[...this.entries.values()].sort((a,b)=>a.entry.name.localeCompare(b.entry.name));
    const histories=entries.flatMap(({entry})=>{
      const metadata=entry.metadata as any;
      if(['unit-observations-v2','unit-observations-v3'].includes(metadata?.unitHistoryProfile))return [{entry:entry.name,snapshot:{
        profile:metadata.unitHistoryProfile,source:metadata.unitHistorySource,units:metadata.units,root:'toestand',
        locatorSemantics:'Fields and labels use XPath relative to their unit/event locator; absolute locators remain absolute',documentaryLayers:[],corrections:metadata.unitCorrections??[]} as UnitSnapshot}];
      return (metadata?.unitHistory??[]).map((snapshot:UnitSnapshot)=>({entry:entry.name,snapshot}));
    });
    const document={schemaVersion:1,jurisdiction:this.jurisdiction,identifier:this.identifier,range:this.range,
      ...options.diagnosticOnly?{diagnosticOnly:true as const}:{},
      dateSemantics:'Official state/layer dates are not individual provision entry-into-force or applicability dates.',
      entries:entries.map(x=>({...x.entry,metadata:encodeUnitMetadata(x.entry.metadata,this.jurisdiction)})),warnings:[...this.warnings].sort(),
      ...issueFields,
      ...this.discovery?{discovery:this.discovery}:{},
      ...histories.length?{catalogFormat:'canonical-compact-json-v1' as const}:{},
      ...histories.length?{unitHistory:{sources:histories.map(({entry,snapshot}:any)=>({entry,...snapshot.source})),
        ...linkOfficialUnitObservations(histories.map((h:any)=>h.snapshot)),wtiCorrelations:entries.flatMap(({entry})=>{
          const history=(entry.metadata as any)?.wtiHistory;
          return history?[{entry:entry.name,correlations:correlateWtiUnits(history,histories.map((h:any)=>h.snapshot))}]:[];
        })}}:{}};
    const data:Record<string,[Uint8Array,{mtime:Date}]>={};
    // ZIP stores local DOS date fields without a timezone. UTC midnight may
    // become 1979 west of UTC and is then rejected. Fix the local wall date;
    // this changes no downloaded source bytes or nested official ZIP archive.
    const mtime=new Date(1980,0,1,0,0,0);
    for(const e of entries)if(e.bytes)data[e.entry.name]=[e.bytes,{mtime}];
    data['manifest.json']=[Buffer.from(histories.length?stableCompactJson(document):stableJson(document)),{mtime}];
    let bytes:Buffer;
    if(entries.some(e=>e.filePath)){
      const parent=process.env.LAW_SOURCE_CACHE_DIR??path.join(process.cwd(),'.source-cache');fs.mkdirSync(parent,{recursive:true});
      const temp=fs.mkdtempSync(path.join(parent,'zip-work-'));
      try{
        const catalog=path.join(temp,'manifest.json');fs.writeFileSync(catalog,data['manifest.json'][0]);
        const files=entries.map((e,i)=>{if(e.filePath)return {name:e.entry.name,path:path.resolve(e.filePath),size:e.entry.size,sha256:e.entry.sha256};const file=path.join(temp,'input-'+i);fs.writeFileSync(file,e.bytes!);return {name:e.entry.name,path:path.resolve(file),size:e.entry.size,sha256:e.entry.sha256};});
        const recipe=path.join(temp,'recipe.json'),target=path.join(temp,'source.zip');fs.writeFileSync(recipe,JSON.stringify({files,catalog:path.resolve(catalog),target:path.resolve(target)}));
        const root=fileURLToPath(new URL('../',import.meta.url));
        const result=spawnSync(process.env.LAW_XML_PYTHON??'python3',[path.join(root,'scripts/build_source_zip.py'),recipe],{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:600_000,maxBuffer:65536});
        if(result.error||result.status!==0)throw new Error(`Streaming original-source archive creation failed (${result.status??'signal'}, ${(result.error as NodeJS.ErrnoException|undefined)?.code??'helper'}).`);bytes=fs.readFileSync(target);
      }finally{fs.rmSync(temp,{recursive:true,force:true});}
    }else bytes=Buffer.from(zipSync(data,{level:6}));
    return {bytes,metadata:{...fileMetadata(name,bytes),entryCount:entries.length,warnings:document.warnings,model:this.jurisdiction==='NL'?'BWB':'CELLAR',
      ...options.diagnosticOnly?{diagnosticOnly:true as const}:{reportEvidence:sourceReportEvidence({...document,entries:entries.map(x=>x.entry)})},
      ...this.unclassifiedWarnings.size?{}:{sourceIssueProfile:'source-issues-v1' as const},...document.catalogFormat?{catalogFormat:document.catalogFormat}:{}}};
  }
}
export function unpackOfficialZip(bytes:Uint8Array):Record<string,Uint8Array> {
  const inventory=zipInventory(bytes);
  let total=0;
  for(const [name,entry] of inventory)
    if(!safePath(name)||process.env.LAW_PUBLIC_INCREMENTAL!=='1'&&(entry.size>64_000_000||(total+=entry.size)>256_000_000))throw new Error('Unsafe or oversized official ZIP.');
  return decodeZipPayloads(bytes,inventory);
}
export function loadSourceArchive(bytes:Buffer,expected:SourceArchive,jurisdiction:string,identifier:string):{index:any;items:Record<string,Uint8Array>} {
  if(!safeArchiveName(expected.name)||expected.size!==bytes.length||expected.md5!==checksum(bytes))throw new Error('Official source archive checksum mismatch.');
  const items=unpackOfficialZip(bytes),index=JSON.parse(Buffer.from(items['manifest.json']??[]).toString('utf8'));
  if(index.schemaVersion!==1||index.jurisdiction!==jurisdiction||index.identifier!==identifier||
    !Array.isArray(index.entries)||!index.entries.length||expected.entryCount!==index.entries.length||
    (index.catalogFormat!==undefined&&index.catalogFormat!=='canonical-compact-json-v1')||index.catalogFormat!==expected.catalogFormat||
    (index.catalogFormat?stableCompactJson(index):stableJson(index))!==Buffer.from(items['manifest.json']).toString('utf8')||
    JSON.stringify(index.warnings)!==JSON.stringify(expected.warnings)||expected.model!==(jurisdiction==='NL'?'BWB':'CELLAR'))throw new Error('Invalid official source catalog.');
  const names=new Set(['manifest.json']);
  for(const e of index.entries){
    if(!safePath(e.name)||names.has(e.name)||!items[e.name]||items[e.name].length!==e.size||checksum(items[e.name])!==e.md5||
      e.sha256!==undefined&&(typeof e.sha256!=='string'||!/^[a-f0-9]{64}$/.test(e.sha256)||createHash('sha256').update(items[e.name]).digest('hex')!==e.sha256)||
      !['https:','http:'].includes(new URL(e.url).protocol))throw new Error('Invalid official source bytes/catalog.');
    names.add(e.name);
  }
  if(Object.keys(items).length!==names.size)throw new Error('Unexpected official ZIP entry.');
  if(index.diagnosticOnly!==expected.diagnosticOnly||(index.diagnosticOnly!==undefined&&index.diagnosticOnly!==true))throw new Error('Source diagnostic marker differs from archive declaration.');
  if(index.sourceIssueProfile!==expected.sourceIssueProfile)throw new Error('Source issue profile differs from archive declaration.');
  sourceAvailability(index);
  for(const entry of index.entries)decodeUnitMetadata(entry.metadata,jurisdiction);
  if(expected.reportEvidence!==undefined&&!isDeepStrictEqual(expected.reportEvidence,sourceReportEvidence(index,items)))throw new Error('Source report evidence differs from archived observations.');
  return {index,items};
}
export function validateSourceArchive(bytes:Buffer,expected:SourceArchive,jurisdiction:string,identifier:string):any {
  return loadSourceArchive(bytes,expected,jurisdiction,identifier).index;
}

// Direct unit attributes only: absence of dates remains absence, never inheritance
// from a parent article, state date, JCI g/z parameter or another version.
export function bwbUnits(bytes:Uint8Array):unknown[] {
  const doc=xmlObject(bytes),units:unknown[]=[];
  function visit(node:any,tag:string):void {
    if(Array.isArray(node)){node.forEach(n=>visit(n,tag));return;}
    if(!node||typeof node!=='object')return;
    if(['artikel','lid','li','bijlage'].includes(tag)){
      const attributes=Object.fromEntries(Object.entries(node).filter(([k])=>k.startsWith('@_')).map(([k,v])=>[k.slice(2),v]));
      units.push({element:tag,attributes,jci:node['meta-data']?.jcis?.jci??null});
    }
    for(const [key,value]of Object.entries(node))if(!key.startsWith('@_'))visit(value,key);
  }
  visit(doc,'');return units;
}
export function formexInfo(bytes:Uint8Array,celex:string,sourceUrl:string|null=null):{root:string;layers:Record<string,string>[];members:string[];unitHistory:UnitSnapshot[]} {
  const files=unpackOfficialZip(bytes),layers:Record<string,string>[]=[],unitHistory:UnitSnapshot[]=[];let root='';
  for(const [name,content]of Object.entries(files)){
    if(!/\.xml$/i.test(name)||/\.doc\.xml$/i.test(name))continue;
    const doc=xmlObject(content),key=Object.keys(doc).find(k=>!k.startsWith('?'))!;
    if(!['ACT','CONS.ACT','CONS.OTH','JUDGMENT','GENERAL','CORR'].includes(key))continue;
    root=key;
    unitHistory.push(observeUnits(content,{jurisdiction:'EU',documentId:celex,url:sourceUrl,member:name,containerSha256:createHash('sha256').update(bytes).digest('hex')}));
    function scan(n:any):void {if(Array.isArray(n)){n.forEach(scan);return;}if(!n||typeof n!=='object')return;
      for(const [k,v]of Object.entries(n)){
        if(k==='INFO.CONSLEG'){
          const a=Object.fromEntries(Object.entries(v as any).filter(([p])=>p.startsWith('@_')).map(([p,x])=>[p.slice(2),String(x)]));
          if(celex.startsWith('0')&&(a['CONSLEG.REF']!==celex.slice(1,10)||a['START.DATE']!==celex.slice(11)))throw new Error('Formex layer does not match requested CELEX.');
          layers.push(a);
        }else scan(v);
      }}scan(doc[key]);
  }
  if(!root||celex.startsWith('0')&&!layers.length)throw new Error('Missing matching Formex legal document.');
  return {root,layers,members:Object.keys(files).sort(),unitHistory};
}
