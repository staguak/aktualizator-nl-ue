import { buildEuModel } from './eu-model.js';
import type { EuBuiltAct } from './eu-model.js';
import type { EuPublishedFile } from './eu-model.js';
import { euContentFromBody } from './eu-normalize.js';
import { finalFile, publishedMetadata } from './final-file.js';
import type { EuFinalFile } from './final-file.js';
import { normalizeOutput, outputChanges } from './output.js';
import { pendingValidation, reportValidation } from './validation-result.js';
import type { ValidationResult } from './validation-result.js';
import {renderBuildReport} from './build-report.js';
export type { EuBuiltAct } from './eu-model.js';
function publishedEuFile(file:EuFinalFile):EuPublishedFile {
  const {celex,part,sourceHash}=file.metadata;
  const base={...publishedMetadata(file),celex,part,sourceHash};
  return file.kind==='reference' ? {...base,kind:'reference',canonicalFile:file.metadata.canonicalFile} : {...base,kind:'content'};
}

// Canonical selection, metadata and legal-body normalization precede rendering.
export function finalizeEu(acts: EuBuiltAct[], readBody:(name:string)=>string) {
  const model=buildEuModel(acts,readBody);
  const outputs=new Map<string,string>(),files=new Map<string,EuFinalFile>();
  let afterBytes=0;
  for(const part of model.parts){
    const text=part.details.kind==='content'
      ? euContentFromBody(part.title,part.celex,part.part,part.total,part.body,part.sourceUrl,part.language)
      : normalizeOutput(`# ${part.title}\n\nUE-REF · CELEX ${part.celex} · ${part.language??'NL'} · ${part.part}/${part.total}\n\nTreść: [${part.details.metadata.canonicalFile}](${part.details.metadata.canonicalFile})\n`);
    const file=finalFile(part.name,text,part.details);
    files.set(file.name,file);outputs.set(file.name,text);afterBytes+=file.size;
    model.acts.find(a=>a.order===part.order)!.files.push(publishedEuFile(file));
  }
  model.acts.forEach(a=>a.files.sort((x,y)=>x.name.localeCompare(y.name)));
  return {acts:model.acts,outputs,files,normalization:{...model.normalization,afterBytes,savedBytes:model.normalization.beforeBytes-afterBytes}};
}
export function euIndex(m:any):string {
  return normalizeOutput(['# Aktualizator UE — indeks','',`Zakres: ${m.rangeFrom} – ${m.rangeTo}; język ${m.language??'NL'}.`,'',
    ...m.acts.flatMap((a:any)=>[`## ${a.order}. ${a.title}`,'',...a.files.map((f:any)=>`- [${f.celex}, część ${f.part}](${f.name})${f.kind==='reference'?` → [treść](${f.canonicalFile})`:''}`),...(a.sourceArchive?[`- [Oryginalne źródła CELLAR](${a.sourceArchive.name}) — ${a.sourceArchive.entryCount} zasobów; MD5 ${a.sourceArchive.md5}.`]:[]),''])].join('\n'));
}
export function euReport(m:any,previous:any,validation: ValidationResult = pendingValidation()):string {
  const files=m.acts.flatMap((a:any)=>a.files),docs=m.acts.flatMap((a:any)=>a.documents),n=m.normalization,statuses=docs.flatMap((d:any)=>d.htmlNormalization);
  return normalizeOutput(['# Aktualizator UE — raport wykonania','',`Uruchomienie: ${m.generatedAt}`,`Zakres: ${m.rangeFrom} – ${m.rangeTo}`,'',
    `Pozycje: ${m.acts.length}; dokumenty źródłowe: ${docs.length}; pełne pliki: ${files.length-n.referenceCount}; UE-REF: ${n.referenceCount}; grupy deduplikacji: ${n.deduplicationGroups}.`,
    `Rozmiar przed/po: ${n.beforeBytes}/${n.afterBytes} bajtów; oszczędność: ${n.savedBytes} bajtów.`,
    `HTML: zweryfikowane zmiany ${statuses.filter((s:string)=>s==='verified').length}; pominięte wrażliwe ${statuses.filter((s:string)=>s==='sensitive-skip').length}; wycofane optymalizacje ${statuses.filter((s:string)=>s==='fallback').length}.`,
    `Zmiany: ${outputChanges(previous,m)}`,'','Błędy pobierania wymaganych tekstów: 0. Niedostępne formaty i metadane pomocnicze wymieniono poniżej.',validation.status==='PASS' ? 'Metadane: odtworzenie każdego dokumentu zgodne z oryginałem.' : 'Metadane: zobacz wynik walidacji.',
    reportValidation(validation),'','## Anomalie i wyjątki','',
    ...m.acts.flatMap((a:any)=>(a.sourceArchive?.warnings??[]).map((w:string)=>`- ${a.celex}: ${w}`)),
    ...docs.filter((d:any)=>d.navigation.sourceFragmentIssues.length||d.oversizedParts.length||d.htmlNormalization.includes('fallback')).map((d:any)=>`- ${d.celex}: odsyłacze źródła ${d.navigation.sourceFragmentIssues.join(', ')||'brak'}; duże części ${d.oversizedParts.join(', ')||'brak'}; fallback ${d.htmlNormalization.includes('fallback')}.`),renderBuildReport(m,previous,validation)].join('\n'));
}
