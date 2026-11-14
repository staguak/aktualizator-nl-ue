import type {NlModel} from './nl-model.js';
import type {RenderedChunk} from './types.js';
import {finalFile} from './final-file.js';
import {LEGAL_PROFILE,legalHash,legalPartName,legalMarkdown,legalChunkContext,indexLegalDocument,validateLegalDocument,extractLegalBody} from './legal-structure.js';
import type {LegalManifest} from './legal-structure.js';
import {resolveEuNavigation} from './eu-navigation.js';
import {assertEuIntegrity,htmlIntegrity} from './content-integrity.js';

export function renderNlLegalModel(model:NlModel):NlModel&{chunks:RenderedChunk[];legalDocuments:LegalManifest[]}{
  if(!model.legalVersions?.length)throw new Error('No complete NL legal versions.');
  const chunks:RenderedChunk[]=[],legalDocuments:LegalManifest[]=[];
  for(const draft of model.legalVersions){
    const prefix=`${String(model.act.order).padStart(2,'0')}_${model.act.bwbId}_v${legalHash(draft.version).slice(0,16)}_NL`;
    const names=draft.chunks.map(chunk=>legalPartName(prefix,chunk));
    const resolved=resolveEuNavigation(draft.chunks.map(c=>c.body),names,draft.sourceUrl,true);
    assertEuIntegrity(htmlIntegrity(draft.chunks.map(c=>c.body).join('')),resolved.chunks.join(''));
    const manifest=indexLegalDocument({...draft,sourceFragmentIssues:resolved.navigation.sourceFragmentIssues},names,resolved.chunks);legalDocuments.push(manifest);
    resolved.chunks.forEach((body,i)=>{
      const articles=manifest.units.filter(u=>u.kind==='article'&&u.locations.some(l=>l.file===names[i])).flatMap(u=>u.reference?[u.reference]:[]);
      const content=legalMarkdown(model.act.title,draft,body,legalChunkContext(draft,body));
      const file=finalFile(names[i],content,{jurisdiction:'NL',kind:'content',metadata:{articles,layoutProfile:LEGAL_PROFILE}});
      chunks.push({file,fileName:file.name,content,articleCount:articles.length,articles});
    });
    validateLegalDocument(manifest,name=>extractLegalBody(chunks.find(c=>c.fileName===name)!.content));
  }
  return {...model,chunks,legalDocuments};
}
