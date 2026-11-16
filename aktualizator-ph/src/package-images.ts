import {writeCorpusManifest} from './legal-manifest-files.js';
import fs from 'node:fs';
import path from 'node:path';
import {buildLegalImagePackage,IMAGE_INDEX,legalDocuments} from './legal-images.js';
import type {EuImageLoader} from './eu-assets.js';
import {createOfficialImageResolver} from './eu-image-resolver.js';
import {fileMetadata,stableJson} from './output.js';
import {loadValidatedFiles} from './validation-context.js';
import {completeBuiltOutput} from './publication-validation.js';
import type {ExpectedAct} from './validation-context.js';
import {nlIndex,nlReport} from './nl-output.js';
import {euIndex,euReport} from './eu-output.js';
import {renderBase64Markdown,restoreCanonicalMarkdown} from './inline-legal-images.js';
export {officialImage} from './official-image-source.js';
/** Sources and canonical legal text have passed their checks. Encode only
 * graphical presentation, with an exact reversible recipe and native originals. */
export async function finalizePackageImages(dir:string,acts:ExpectedAct[],loader:EuImageLoader=createOfficialImageResolver()){
  const before=loadValidatedFiles(dir,acts),manifest=before.manifest;
  if(manifest.imagePackage)throw new Error('Image package was already finalized.');
  for(const act of manifest.acts)act.sourceArchive.distribution={bundle:manifest.jurisdiction==='NL'?'NL-sources.zip':'UE-sources.zip',prefix:act.sourceArchive.name.replace(/\.sources\.zip$/,'')};
  const documents=legalDocuments(manifest);
  if(manifest.jurisdiction==='EU'&&manifest.acts.some((a:any)=>a.files.some((f:any)=>f.kind==='reference')))throw new Error('Rebuild public EU output with complete text instead of UE-REF files before Base64 finalization.');
  if(documents.length!==manifest.acts.reduce((n:number,a:any)=>n+(a.legalDocuments?.length??a.documents?.length??0),0))throw new Error('Images require complete legal manifests.');
  const result=await buildLegalImagePackage(documents,name=>before.text(name),loader);
  const rendered=new Map<string,Buffer>();
  const names=[...new Set(documents.flatMap(d=>d.parts.map(p=>p.file)))].sort();
  result.index.rendering={profile:'inline-base64-v1',offsetEncoding:'utf16-code-units',patchScope:'full-markdown',legalOffsetScope:'restored-canonical-body',files:[]};
  for(const name of names){
    const view=renderBase64Markdown(name,before.text(name),result.index,n=>result.assets.get(n)!);
    rendered.set(name,Buffer.from(view.text));result.index.rendering.files.push(view.recipe);
  }
  for(const [name,bytes]of rendered)if(restoreCanonicalMarkdown(name,bytes.toString('utf8'),result.index)!==before.text(name))throw new Error('Inline graphics changed canonical legal text.');
  const indexBytes=Buffer.from(stableJson(result.index));
  const imageDirectory=path.join(dir,'images');
  if(fs.existsSync(imageDirectory))throw new Error('Unexpected preexisting image directory.');
  if(result.assets.size)fs.mkdirSync(imageDirectory);
  for(const [name,bytes]of result.assets)fs.writeFileSync(path.join(dir,name),bytes,{flag:'wx'});
  for(const [name,bytes]of rendered)fs.writeFileSync(path.join(dir,name),bytes);
  for(const act of manifest.acts)for(const file of act.files){const bytes=rendered.get(file.name);if(bytes)Object.assign(file,fileMetadata(file.name,bytes));}
  fs.writeFileSync(path.join(dir,IMAGE_INDEX),indexBytes,{flag:'wx'});
  manifest.imagePackage={profile:result.index.profile,rendering:'inline-base64-v1',legalOffsetScope:'restored-canonical-body',unavailableImages:result.index.unavailableImages?.length??0,index:fileMetadata(IMAGE_INDEX,indexBytes),assets:[...result.assets].map(([name,bytes])=>fileMetadata(name,bytes))};
  const jurisdiction=manifest.jurisdiction;
  writeCorpusManifest(dir,manifest);
  fs.writeFileSync(path.join(dir,'INDEX.md'),jurisdiction==='NL'?nlIndex(manifest):euIndex(manifest));
  completeBuiltOutput(dir,acts,r=>jurisdiction==='NL'?nlReport(manifest,null,r):euReport(manifest,null,r));
  for(const [name,file]of before.files)if(!['manifest.json','INDEX.md','REPORT.md'].includes(name)){
    const bytes=fs.readFileSync(path.join(dir,name));
    if(rendered.has(name)?restoreCanonicalMarkdown(name,bytes.toString('utf8'),result.index)!==file.text:!bytes.equals(file.bytes))throw new Error('Image encoding changed canonical Markdown or original sources.');
  }
  return result.index;
}
