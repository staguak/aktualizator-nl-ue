import assert from 'node:assert/strict';
import { assertIntegrity, fingerprintText, assertEuIntegrity, nlOutputIntegrity } from './content-integrity.js';
import { extractEuBody, legalBodyHash, expandMetadata, metadataHash } from './eu-normalize.js';
import { validateEuNavigation } from './eu-navigation.js';
import { nlIndex } from './nl-output.js';
import { euIndex } from './eu-output.js';
import type { ValidationContext } from './validation-context.js';

import { parseNlFinal } from './nl-final-parser.js';
export { parseNlFinal } from './nl-final-parser.js';
import { isCalendarDate as date } from './calendar.js';
import {assertEuCaseCoverage} from './eu-case-scope.js';
import {validateLegalDocument,extractLegalBody} from './legal-structure.js';
export function validateV2(context:ValidationContext):void {
  const m = context.manifest, expectedActs = context.expectedActs;
  if(m.validationVersion!==2)throw new Error('Missing final validation v2.');
  const map=new Map<string,any>(m.acts.flatMap((a:any)=>a.files.map((f:any)=>[f.name,f])));
  if(m.jurisdiction==='NL') {
    for(const act of m.acts) {
      const expected=expectedActs.find(a=>a.order===act.order);
      if(!Array.isArray(act.selectedArticles)||!Array.isArray(act.articles)||!Array.isArray(act.sourceStates)||
        !Number.isInteger(act.fetchedStates)||act.fetchedStates!==act.sourceStates.length)throw new Error('Incomplete NL v2 structure.');
      if(expected?.include)assert.deepEqual(act.selectors,expected.include);
      const full=expected?.retrievalScope==='full-act';
      if(full&&(act.retrievalScope!=='full-act'||!Array.isArray(act.requestedArticles)))throw new Error('NL retrieval scope differs from configuration.');
      if(expected?.outputProfile==='legal-structure-v1'&&!act.legalDocuments?.length)throw new Error('NL output lacks the configured legal structure.');
      const covers=(id:string)=>act.selectedArticles.some((selected:string)=>selected===id||full&&selected.endsWith(':'+id));
      if(typeof expected?.include !== 'string' && expected?.include?.articles?.some(id=>!covers(id))||expected?.mustIncludeArticles?.some(id=>!covers(id)))throw new Error('NL selector coverage incomplete.');
      act.sourceStates.forEach((s:any,i:number)=>{if(s.index!==i||typeof s.key!=='string'||!date(s.validFrom)||
        s.validTo!==null&&(!date(s.validTo)||s.validTo<s.validFrom||s.validTo==='9999-12-31'))throw new Error('Invalid NL source-state catalog.');});
      if(act.legalDocuments){
        for(const document of act.legalDocuments)validateLegalDocument(document,name=>extractLegalBody(context.text(name)));
        continue;
      }
      assertIntegrity(act.integrity,nlOutputIntegrity(act.files.map((f:any)=>context.text(f.name))));
      const reconstructed:any[]=[];
      for(const file of act.files){
        const articles=parseNlFinal(context.text(file.name));
        assert.deepEqual(articles.map(a=>a.articleId),file.articles);
        if(file.articleCount!==articles.length||!articles.length)throw new Error('NL file article count mismatch.');
        if(file.size>50_000&&articles.length>1)throw new Error('NL chunk limit exceeded by multiple articles.');
        reconstructed.push(...articles);
      }
      assert.deepEqual(reconstructed.map(a=>a.articleId),act.selectedArticles);
      assert.deepEqual(act.articles.map((a:any)=>a.articleId),act.selectedArticles);
      if(new Set(act.selectedArticles).size!==act.selectedArticles.length)throw new Error('Duplicate NL article.');
      for(const [i,article]of act.articles.entries()){
        const result=reconstructed[i];if(!article.versions.length||result.versions.length!==article.versions.length)throw new Error('NL version count mismatch.');
        article.versions.forEach((v:any,j:number)=>{
          const output=result.versions[j];
          if(v.validFrom!==output.validFrom||v.validTo!==output.validTo||!date(v.validFrom)||
            // BWB intervals are inclusive: a version may legally last one day.
            (v.validTo!==null&&(!date(v.validTo)||v.validFrom>v.validTo||v.validTo==='9999-12-31'))||
            j>0&&(article.versions[j-1].validTo===null||article.versions[j-1].validTo>=v.validFrom))throw new Error('Invalid NL version interval/order.');
          if(!Array.isArray(v.sourceStates)||v.sourceStateCount!==v.sourceStates.length||!v.sourceStateCount||v.merged!==(v.sourceStateCount>1)||
            v.sourceStates.some((s:any,k:number)=>!Number.isInteger(s)||s<0||s>=act.fetchedStates||(k>0&&s!==v.sourceStates[k-1]+1)))throw new Error('Invalid NL merged source states.');
          if(v.validFrom!==act.sourceStates[v.sourceStates[0]].validFrom)throw new Error('NL version start differs from its first source state.');
          const observations=v.sourceStates.map((s:number)=>act.sourceStates[s]);
          const expectedEnd=observations.some((s:any)=>s.validTo===null)?null:
            observations.reduce((end:string,s:any)=>s.validTo>end?s.validTo:end,'');
          if(v.validTo!==expectedEnd)throw new Error('NL version end differs from its source observations.');
          observations.forEach((s:any,k:number)=>{
            if(!k)return;
            const previous=observations[k-1],nextDay=previous.validTo===null?null:new Date(previous.validTo+'T00:00:00Z');
            if(nextDay)nextDay.setUTCDate(nextDay.getUTCDate()+1);
            if(s.validFrom<previous.validFrom||previous.validTo===null&&s.validFrom!==previous.validFrom||
              nextDay&&s.validFrom>nextDay.toISOString().slice(0,10))throw new Error('NL merged observations do not establish a continuous interval.');
          });
          if(output.sourceCount!==v.sourceStateCount)throw new Error('NL source references differ from actual merged-state count.');
          if(!/^[a-f0-9]{64}$/.test(v.contentHash)||v.contentHash!==fingerprintText(output.content).sha256)throw new Error('NL per-version legal content mismatch.');
        });
      }
    }
    if(context.text('INDEX.md')!==nlIndex(m))throw new Error('NL index mismatch.');
  } else if(m.jurisdiction==='EU') {
    const canonicalBodies=new Map<string,{name:string;body:string}>();
    const content=(file:any):{name:string;body:string}=>{
      if(file.kind==='reference'){
        const target=map.get(file.canonicalFile);
        if(!target||target.kind!=='content'||target.sourceHash!==file.sourceHash)throw new Error('Invalid UE-REF canonical target/hash.');
        const stub=context.text(file.name);
        if(!stub.includes('UE-REF')||!stub.includes(`[${target.name}](${target.name})`)||stub.includes('<!-- EU legal body -->')||Buffer.byteLength(stub)>2048)throw new Error('Invalid UE-REF output.');
        return content(target);
      }
      if(file.kind!=='content'||file.canonicalFile!==undefined)throw new Error('Invalid EU file kind.');
      const cached=canonicalBodies.get(file.name);if(cached)return cached;
      const body=file.layoutProfile==='legal-structure-v1'?extractLegalBody(context.text(file.name)):extractEuBody(context.text(file.name));
      if(legalBodyHash(body)!==file.sourceHash)throw new Error('EU body hash mismatch.');
      const result={name:file.name,body};canonicalBodies.set(file.name,result);return result;
    };
    for(const act of m.acts){
      const expected=expectedActs.find(a=>a.order===act.order);
      if(!act.documents?.length||new Set(act.documents.map((d:any)=>d.celex)).size!==act.documents.length)throw new Error('Invalid EU documents.');
      assertEuCaseCoverage(act,expected);
      for(const id of [...expected?.requiredVersions??[],...expected?.attachedDocuments?.map((d:any)=>d.celex)??[]])if(!act.documents.some((d:any)=>d.celex===id))throw new Error('Missing EU required document.');
      if(act.files.some((f:any)=>!act.documents.some((d:any)=>d.celex===f.celex)))throw new Error('Unexpected EU document file.');
      for(const doc of act.documents){
        if(expected?.outputProfile==='legal-structure-v1'&&!doc.legalStructure)throw new Error('EU output lacks configured legal structure.');
        if(metadataHash(expandMetadata(doc.metadata,doc.celex,m.normalization))!==doc.metadataHash)throw new Error('EU metadata reconstruction mismatch.');
        const files=act.files.filter((f:any)=>f.celex===doc.celex).sort((a:any,b:any)=>a.part-b.part);
        if(!files.length||files.some((f:any,i:number)=>f.part!==i+1)||!doc.htmlNormalization?.length||doc.htmlNormalization.length!==files.length)throw new Error('Incomplete EU document parts.');
        const resolved=files.map(content);
        if(!/^[a-f0-9]{64}$/.test(doc.sourceSha256)||! /^[a-f0-9]{64}$/.test(doc.inputBodyHash)||doc.sourceHash!==legalBodyHash(resolved.map((r:any)=>r.body).join(doc.legalStructure?'':'\n\n')))throw new Error('EU document body/source hash mismatch.');
        assertEuIntegrity(doc.integrity,resolved.map((r:any)=>r.body).join(doc.legalStructure?'':'\n'));
        if(doc.legalStructure){
          assert.deepEqual(doc.legalStructure.parts.map((p:any)=>p.file),resolved.map((r:any)=>r.name));
          validateLegalDocument(doc.legalStructure,(name:string)=>extractLegalBody(context.text(name)));
        }
        if(doc.textLength!==resolved.reduce((n:number,r:any)=>n+r.body.length,0))throw new Error('EU legal body length mismatch.');
        validateEuNavigation(resolved.map((r:any)=>r.body),resolved.map((r:any)=>r.name));
      }
    }
    if(context.text('INDEX.md')!==euIndex(m))throw new Error('EU index mismatch.');
  }else throw new Error('Unexpected jurisdiction.');
}
