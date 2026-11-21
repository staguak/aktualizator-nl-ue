export interface TerritorialEvidence {
  /** Reviewed, source-bound scope for the entire act after checking exceptions. */
  scope: 'UNION' | 'COUNTRIES';
  countries?: readonly string[];
  source: string;
  locator: string;
}

export function territorialApplicability(targetCountries:readonly string[], evidence?:TerritorialEvidence) {
  if(!evidence?.source||!evidence.locator||evidence.scope==='COUNTRIES'&&!evidence.countries?.length)
    return {status:'APPLICABILITY_UNKNOWN' as const,checkedScope:[...targetCountries],sourceEvidence:[]};
  const included=evidence.scope==='UNION'||evidence.countries?.some(country=>targetCountries.includes(country));
  return {status:included?'APPLICABILITY_CONFIRMED' as const:'APPLICABILITY_EXCLUDED' as const,
    checkedScope:[...targetCountries],sourceEvidence:[evidence]};
}

// RDF identifiers can have either scheme. Preserve the original value in the evidence.
const ADDRESSEE_PREDICATE=/^https?:\/\/publications\.europa\.eu\/ontology\/cdm#resource_legal_addresses_(?:country|institution)$/;
const AUTHORITY='https://publications.europa.eu/resource/authority/';
const NL_ADDRESSEES=new Set([AUTHORITY+'country/NLD',AUTHORITY+'fd_050/NL']);

export interface TerritorialObservation {
  predicate:string;
  value:string;
  sourceUrl:string;
  sourceSha256:string;
  work?:string;
}

export function territorialObservation(predicate:string,value:string,sourceUrl:string,sourceSha256:string,
  work?:string):TerritorialObservation|undefined{
  if(!ADDRESSEE_PREDICATE.test(predicate))return;
  return {predicate,value,sourceUrl,sourceSha256,...work?{work}:{}};
}

/** An express Dutch addressee of a decision establishes scope for that
 * addressee (art. 288 TFEU). Other addressees alone cannot establish exclusion. */
export function assessPublicEuDocument(celex:string,targets:readonly string[],observations:readonly TerritorialObservation[]=[]){
  const candidates=observations.filter(row=>NL_ADDRESSEES.has(row.value.replace(/^http:/,'https:')));
  const confirmed=targets.includes('NL')&&/^3\d{4}D\d{4}$/.test(celex)&&candidates.length>0;
  if(confirmed){
    const evidence=candidates[0];
    return {...territorialApplicability(targets,{
      scope:'COUNTRIES',countries:['NL'],source:evidence.sourceUrl,locator:evidence.predicate
    }),addressedTo:[...observations],legalEffectScope:'EXPRESS_NL_ADDRESSEE',unitApplicability:'APPLICABILITY_UNKNOWN'};
  }
  return {...territorialApplicability(targets),addressedTo:[...observations],
    legalEffectScope:'UNDETERMINED',unitApplicability:'APPLICABILITY_UNKNOWN'};
}
