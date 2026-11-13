export const SOURCE_CLASSES=['COMPLETE','COMPLETE_FALLBACK','METADATA_INCOMPLETE','HISTORY_INCOMPLETE','SOURCE_UNAVAILABLE','CRITICAL','NOT_OBSERVED','REPRESENTATION_REJECTED'] as const;
export interface SourceIssue {
  classification:Exclude<typeof SOURCE_CLASSES[number],'COMPLETE'|'COMPLETE_FALLBACK'>;
  code:string;message:string;representation?:string;documentId?:string;
}
export function validateSourceIssues(issues:unknown,warnings:unknown):asserts issues is SourceIssue[]{
  if(!Array.isArray(issues)||!Array.isArray(warnings)||warnings.some(w=>typeof w!=='string'))throw new Error('Invalid typed source issues.');
  const keys=new Set<string>();
  for(const issue of issues){
    if(!issue||typeof issue!=='object'||!SOURCE_CLASSES.slice(2).includes(issue.classification)||
      Object.keys(issue).some(k=>!['classification','code','message','representation','documentId'].includes(k))||
      typeof issue.code!=='string'||!/^[A-Z][A-Z0-9_]{2,80}$/.test(issue.code)||typeof issue.message!=='string'||!warnings.includes(issue.message)||
      ['representation','documentId'].some(k=>issue[k]!==undefined&&(typeof issue[k]!=='string'||!issue[k])))throw new Error('Invalid typed source issue.');
    const key=JSON.stringify(issue);if(keys.has(key))throw new Error('Duplicate typed source issue.');keys.add(key);
  }
  if(warnings.some(w=>!issues.some(i=>i.message===w)))throw new Error('Unclassified source warning.');
}
export interface SourceAvailability {
  identifier:string;profile:'source-issues-v1'|'LEGACY_UNCLASSIFIED';issues:SourceIssue[];
  legacyWarnings:string[];hasOfficialTextFallback:boolean;
}
export function sourceAvailability(index:any):SourceAvailability{
  if(index.sourceIssueProfile===undefined){
    if(index.sourceIssues!==undefined)throw new Error('Source issues lack a profile.');
    return {identifier:index.identifier,profile:'LEGACY_UNCLASSIFIED',issues:[],legacyWarnings:index.warnings,hasOfficialTextFallback:false};
  }
  if(index.sourceIssueProfile!=='source-issues-v1')throw new Error('Unknown source issue profile.');
  validateSourceIssues(index.sourceIssues,index.warnings);
  const documents=new Set([index.identifier,...index.entries.map((e:any)=>e.metadata?.celex).filter((id:unknown)=>typeof id==='string')]);
  if(index.sourceIssues.some((i:SourceIssue)=>i.documentId!==undefined&&!documents.has(i.documentId)))throw new Error('Source issue document identity mismatch.');
  return {identifier:index.identifier,profile:index.sourceIssueProfile,issues:index.sourceIssues,legacyWarnings:[],
    hasOfficialTextFallback:index.sourceIssues.some((i:SourceIssue)=>i.representation==='Formex'&&['SOURCE_UNAVAILABLE','REPRESENTATION_REJECTED'].includes(i.classification)&&
      index.entries.some((e:any)=>e.kind==='CELLAR-XHTML'&&e.metadata?.celex===i.documentId&&e.metadata?.language==='EN'))};
}

/** Stable observations, including old typed archives, without rewriting them.
 * An availability class alone is not proof of a failed HTTP request. */
export function sourceFindingCounts(availability:SourceAvailability[]|undefined){
  if(!availability)return {notObserved:null,retrievalFailures:null,rejectedRepresentations:null,unclassifiedAvailabilityIssues:null};
  const totals={notObserved:0,retrievalFailures:0,rejectedRepresentations:0,unclassifiedAvailabilityIssues:0};
  for(const a of availability){
    totals.unclassifiedAvailabilityIssues+=a.legacyWarnings.length;
    for(const issue of a.issues){
      if(issue.classification==='NOT_OBSERVED'||issue.code==='FORMEX_NOT_PUBLISHED')totals.notObserved++;
      else if(issue.classification==='REPRESENTATION_REJECTED'||issue.code==='FORMEX_REJECTED')totals.rejectedRepresentations++;
      else if(issue.code==='FORMEX_RETRIEVAL_FAILED')totals.retrievalFailures++;
      else if(issue.classification==='SOURCE_UNAVAILABLE')totals.unclassifiedAvailabilityIssues++;
    }
  }
  return totals;
}
