import fs from 'node:fs';
import path from 'node:path';
import {buildLegalImagePackage,IMAGE_INDEX,legalDocuments} from './legal-images.js';
import type {EuImageLoader} from './eu-assets.js';
import {fetchBinarySource} from './source-cache.js';
import {fileMetadata,stableJson} from './output.js';
import {loadValidatedFiles} from './validation-context.js';
import {completeBuiltOutput} from './publication-validation.js';
import type {ExpectedAct} from './validation-context.js';
import {nlIndex,nlReport} from './nl-output.js';
import {euIndex,euReport} from './eu-output.js';
const officialImage:EuImageLoader=async value=>{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||!/(?:^|\.)(?:europa\.eu|overheid\.nl|officielebekendmakingen\.nl|officiele-overheidspublicaties\.nl)$/i.test(url.hostname))throw new Error('Untrusted official image URL.');
  return fetchBinarySource(url.href,{Accept:'image/*'},{cacheDir:process.env.LAW_SOURCE_CACHE_DIR,maxBytes:95_000_000,timeoutMs:60000,allowedHosts:[url.hostname]});
};
/** Legal Markdown has already passed all source checks. This adds only
 * sidecars/control metadata, and verifies that every original file stays exact. */
export async function finalizePackageImages(dir:string,acts:ExpectedAct[],loader:EuImageLoader=officialImage){
  const before=loadValidatedFiles(dir,acts),manifest=before.manifest;
  if(manifest.imagePackage)throw new Error('Image package was already finalized.');
  for(const act of manifest.acts)act.sourceArchive.distribution={bundle:manifest.jurisdiction==='NL'?'NL-sources.zip':'UE-sources.zip',prefix:act.sourceArchive.name.replace(/\.sources\.zip$/,'')};
  const documents=legalDocuments(manifest);
  if(documents.length!==manifest.acts.reduce((n:number,a:any)=>n+(a.legalDocuments?.length??a.documents?.length??0),0))throw new Error('Images require complete legal manifests.');
  const result=await buildLegalImagePackage(documents,name=>before.text(name),loader),indexBytes=Buffer.from(stableJson(result.index));
  const imageDirectory=path.join(dir,'images');
  if(fs.existsSync(imageDirectory))throw new Error('Unexpected preexisting image directory.');
  if(result.assets.size)fs.mkdirSync(imageDirectory);
  for(const [name,bytes]of result.assets)fs.writeFileSync(path.join(dir,name),bytes,{flag:'wx'});
  fs.writeFileSync(path.join(dir,IMAGE_INDEX),indexBytes,{flag:'wx'});
  manifest.imagePackage={profile:'legal-images-v1',index:fileMetadata(IMAGE_INDEX,indexBytes),assets:[...result.assets].map(([name,bytes])=>fileMetadata(name,bytes))};
  const jurisdiction=manifest.jurisdiction;
  fs.writeFileSync(path.join(dir,'manifest.json'),stableJson(manifest));
  fs.writeFileSync(path.join(dir,'INDEX.md'),jurisdiction==='NL'?nlIndex(manifest):euIndex(manifest));
  completeBuiltOutput(dir,acts,r=>jurisdiction==='NL'?nlReport(manifest,null,r):euReport(manifest,null,r));
  for(const [name,file]of before.files)if(!['manifest.json','INDEX.md','REPORT.md'].includes(name)){
    if(!fs.readFileSync(path.join(dir,name)).equals(file.bytes))throw new Error('Image extraction changed original Markdown or sources.');
  }
  return result.index;
}
