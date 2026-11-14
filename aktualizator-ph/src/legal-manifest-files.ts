/** Physical storage only: logical manifests and Markdown remain unchanged. */
import fs from 'node:fs';
import path from 'node:path';
import {writeControlFile} from './final-file.js';
import {stableJson,stableCompactJson,hash,fileMetadata} from './output.js';
import {LEGAL_PROFILE} from './legal-structure.js';

const STORAGE='legal-document-files-v1',REFERENCE='legal-document-reference-v1',MAX=95_000_000;
const contextKeys=['corpus','documentId','version','language','sourceSha256'] as const;
export const isLegalManifestFile=(name:string)=>/^LEGAL_[a-f0-9]{64}\.json$/.test(name);
function mapDocuments(manifest:any,visit:(document:any)=>any):any{
  if(!Array.isArray(manifest.acts))throw new Error('Missing legal manifest acts.');
  return {...manifest,acts:manifest.acts.map((act:any)=>({...act,
    ...act.legalDocuments?{legalDocuments:act.legalDocuments.map(visit)}:{},
    ...act.documents?{documents:act.documents.map((doc:any)=>({...doc,...doc.legalStructure?{legalStructure:visit(doc.legalStructure)}:{}}))}:{}}))};
}
export function writeCorpusManifest(directory:string,manifest:any):void{
  const files=new Map<string,Buffer>();
  const physical=mapDocuments(manifest,doc=>{
    if(doc.profile!==LEGAL_PROFILE)throw new Error('Unsupported logical document for storage.');
    const bytes=Buffer.from(stableCompactJson(doc)),sha256=hash(bytes),file='LEGAL_'+sha256+'.json';
    if(bytes.length>MAX)throw new Error('Legal version index exceeds the technical file limit.');
    files.set(file,bytes);
    return {profile:REFERENCE,file,size:bytes.length,sha256,...Object.fromEntries(contextKeys.map(k=>[k,doc[k]]))};
  });
  if(files.size)physical.legalDocumentStorage=STORAGE;
  const text=stableJson(physical);
  if(Buffer.byteLength(text)>MAX)throw new Error('Corpus index exceeds the technical file limit.');
  for(const [name,bytes] of files){
    const target=path.join(directory,name);
    if(fs.existsSync(target)){
      if(!fs.lstatSync(target).isFile()||!fs.readFileSync(target).equals(bytes))throw new Error('Existing legal index changed.');
    }else fs.writeFileSync(target,bytes,{flag:'wx'});
  }
  writeControlFile(directory,manifest.jurisdiction,'manifest.json',text);
}
export function loadCorpusManifest(physical:any,read:(name:string)=>Buffer){
  const files=new Map<string,{bytes:Buffer;name:string;size:number;md5:string}>();
  const manifest=mapDocuments(physical,ref=>{
    if(ref.profile!==REFERENCE){
      if(physical.legalDocumentStorage===STORAGE)throw new Error('Mixed inline and external legal indexes.');
      return ref;
    }
    if(physical.legalDocumentStorage!==STORAGE||!isLegalManifestFile(ref.file)||!Number.isSafeInteger(ref.size)||ref.size<1||ref.size>MAX||
      !/^[a-f0-9]{64}$/.test(ref.sha256)||ref.file!=='LEGAL_'+ref.sha256+'.json'||
      Object.keys(ref).sort().join()!==['profile','file','size','sha256',...contextKeys].sort().join())throw new Error('Invalid legal index reference.');
    const bytes=files.get(ref.file)?.bytes??read(ref.file);
    if(bytes.length!==ref.size||hash(bytes)!==ref.sha256)throw new Error('Legal index checksum or size mismatch.');
    const doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(doc.profile!==LEGAL_PROFILE||contextKeys.some(k=>doc[k]!==ref[k])||stableCompactJson(doc)!==bytes.toString('utf8'))throw new Error('Legal index identity or encoding mismatch.');
    files.set(ref.file,{...fileMetadata(ref.file,bytes),bytes});return doc;
  });
  if(physical.legalDocumentStorage!==undefined&&(physical.legalDocumentStorage!==STORAGE||!files.size))throw new Error('Invalid legal index storage profile.');
  return {manifest,files};
}
