import type { EuText } from './eu-parser.js';
import type {SourceIssue} from './source-availability.js';
import { fetchSource, fetchBinarySource } from './source-cache.js';
import type { BinarySource, SourceResponse } from './source-cache.js';
import { OfficialSources, xmlObject, formexInfo } from './official-sources.js';
import { shareInFlight } from './concurrency.js';
import {assertEuSourceIdentity} from './eu-source-identity.js';
import {documentDate} from './eu-dates.js';
import {retrySource} from './source-cache.js';
import {validateSourceXml,preserveRejectedSource,XmlValidationInfrastructureError} from './xml-validation.js';
import type {XmlKind,XmlReceipt} from './xml-validation.js';
import {validateFormexXml} from './xml-archive-validation.js';
import {parseEuSource} from './parsed-source-cache.js';

export interface EuAct {
  order: number; title: string; celex: string; include: 'full-document';
  requiredVersions: string[];
  attachedDocuments: { celex: string; include: 'operative-part' }[];
}
export interface EuDocument {
  celex: string; metadata: Record<string, string[]>; role: string; include: string;
}
const CDM = 'http://publications.europa.eu/ontology/cdm#';
const RELATIONS = [
  'resource_legal_amends_resource_legal', 'legislation_secondary_modifies_legislation_secondary',
  'resource_legal_corrects_resource_legal', 'resource_legal_repeals_resource_legal',
  'case-law_annuls_resource_legal',
];
export function checkCelex(id: string): void {
  if (!/^(?:[03]\d{4}[LRD]\d{4}(?:\(\d{2}\))?(?:-\d{8})?|1\d{4}[A-Z]\/TXT|6\d{4}CJ\d{4})(?:R\(\d{2}\))?$/.test(id)) {
    throw new Error(`Unsupported CELEX identifier: ${id}`);
  }
}

async function request(url: string, headers: Record<string, string>): Promise<SourceResponse> {
  return retrySource(()=>fetchSource(url,headers,{cacheDir:process.env.LAW_SOURCE_CACHE_DIR,
    timeoutMs:60_000,allowedHosts:['publications.europa.eu','eur-lex.europa.eu'],maxBytes:16_000_000}),3);
}

export async function discoverEuDocuments(act: EuAct, archive?: OfficialSources): Promise<EuDocument[]> {
  checkCelex(act.celex);
  const extras = act.attachedDocuments.map((d) => { checkCelex(d.celex); return d.celex; });
  const ids = [act.celex, ...extras].map((id) => JSON.stringify(id)).join(',');
  const family = act.celex.startsWith('3') ? ` || STRSTARTS(str(?id), "0${act.celex.slice(1)}-")` : '';
  const relationFilter = RELATIONS.map((p) => `cdm:${p}`).join(',');
  const query = `PREFIX cdm: <${CDM}>
SELECT DISTINCT ?id ?p ?v ?relation WHERE {
  { ?w cdm:resource_legal_id_celex ?id . FILTER(str(?id) IN (${ids})${family}) }
  UNION {
    ?base cdm:resource_legal_id_celex ?baseId . FILTER(str(?baseId) = "${act.celex}")
    ?w ?relation ?base ; cdm:resource_legal_id_celex ?id .
    FILTER(?relation IN (${relationFilter}))
  }
  { ?w ?p ?v .
  FILTER(STRSTARTS(str(?p), "${CDM}") &&
    (regex(str(?p), "date|in-force|ecli|version|information_miscellaneous|consolidat|amend|modif|correct|repeal|annul")
      || ?p = cdm:resource_legal_id_celex)) }
  UNION {
    ?expression cdm:expression_belongs_to_work ?w ; cdm:expression_uses_language ?language .
    BIND(cdm:available_language AS ?p) BIND(?language AS ?v)
  }
} ORDER BY ?id ?p ?v LIMIT 10000`;
  const url = new URL('https://publications.europa.eu/webapi/rdf/sparql');
  url.searchParams.set('query', query);
  url.searchParams.set('format', 'application/sparql-results+json');
  const discovery = await request(url.href, { Accept: 'application/sparql-results+json' });
  archive?.add('discovery.json',discovery,url.href,'CELLAR-SPARQL');
  const result = JSON.parse(discovery.text);
  const rows = result.results?.bindings;
  if (!Array.isArray(rows) || rows.length >= 10000) throw new Error('Incomplete EU discovery response.');
  const documents = new Map<string, EuDocument>();
  for (const row of rows) {
    const id = row.id?.value;
    if (typeof id !== 'string') throw new Error('Malformed EU metadata identifier.');
    checkCelex(id);
    const doc = documents.get(id) ?? { celex: id, metadata: {}, role: row.relation ? 'amendment/correction/legal-effect' :
      id.startsWith('0') ? 'consolidated-documentary-version' : 'original', include: /R\(\d{2}\)$/.test(id) ? 'corrigendum' : 'full-document' };
    const property = row.p?.value?.slice(CDM.length), value = row.v?.value;
    if (!property || typeof value !== 'string') throw new Error('Malformed EU metadata row.');
    const values = doc.metadata[property] ?? [];
    if (!values.includes(value)) values.push(value);
    doc.metadata[property] = values;
    documents.set(id, doc);
  }
  // Required corpus versions remain mandatory even if index migration omits them.
  for (const id of act.requiredVersions) {
    checkCelex(id);
    if (!documents.has(id)) documents.set(id, { celex: id, metadata: {}, role: 'required-corpus-version', include: 'full-document' });
  }
  for (const extra of act.attachedDocuments) {
    const doc = documents.get(extra.celex) ?? { celex: extra.celex, metadata: {}, role: 'required-corpus-judgment', include: extra.include };
    doc.include = extra.include; documents.set(extra.celex, doc);
  }
  if (!rows.length) throw new Error(`EU version index returned no metadata for ${act.celex}.`);
  archive?.completeDiscovery({protocol:'CELLAR-SPARQL',rowCount:rows.length,limit:10000,
    scope:'Configured CELEX family, relations and required pins; completed bounded query.'});
  for (const doc of documents.values()) for (const values of Object.values(doc.metadata)) values.sort();
  return [...documents.values()].sort((a,b)=>a.celex.localeCompare(b.celex));
}

export function selectEuDocuments(documents: EuDocument[], act: EuAct, from: string, to: string, language: 'NL'|'EN' = 'NL'): EuDocument[] {
  const required = new Set([...act.requiredVersions, ...act.attachedDocuments.map((d) => d.celex)]);
  const date=(d:EuDocument):string|undefined=>{
    const value=documentDate(d);
    if(value===null&&(d.celex.startsWith('0')||d.metadata.work_date_document?.length))
      throw new Error(`Invalid or ambiguous documentary date for EU source: ${d.celex}`);
    return value??undefined;
  };
  const code=language==='EN'?'ENG':'NLD';
  const hasRequestedLanguage = (d: EuDocument) => !d.metadata.available_language?.length ||
    d.metadata.available_language.some((language) => language.endsWith('/'+code));
  const consolidated = documents.filter((d) => d.celex.startsWith('0') && hasRequestedLanguage(d) && date(d)! <= to);
  const baseline = consolidated.filter((d) => date(d)! <= from).sort((a,b) => date(b)!.localeCompare(date(a)!))[0];
  const selected = documents.filter((d) => {
    const versionDate = date(d);
    if (required.has(d.celex)) {
      if(!hasRequestedLanguage(d))throw new Error(`Required EU source has no ${language} expression: ${d.celex}`);
      if (versionDate && versionDate > to) throw new Error(`Required EU source lies after run date: ${d.celex}`);
      return true;
    }
    if (!hasRequestedLanguage(d)) return false;
    if (d.celex.startsWith('0')) return d === baseline || (versionDate! >= from && versionDate! <= to);
    const languages = d.metadata.available_language;
    if (languages?.length && !languages.some((language) => language.endsWith('/'+code))) return false;
    // Monitor connected changes in the fixed window and any later than the baseline.
    // Older underlying changes remain represented by the original/baseline full text.
    if (!versionDate) throw new Error(`Missing documentary date for connected EU source: ${d.celex}`);
    const futureEffect = (d.metadata['resource_legal_date_entry-into-force'] ?? []).some((value) => value >= from && value <= to);
    return versionDate <= to && (versionDate >= from || futureEffect || !baseline || versionDate > date(baseline)!);
  });
  return selected.sort((a,b) => a.celex.localeCompare(b.celex));
}

export interface EuSource {html:string;sourceUrl:string;parsed:EuText;nativeSources?:NativeEuSource[];nativeWarnings?:string[];nativeIssues?:SourceIssue[]}
export interface NativeEuSource {name:string;source:BinarySource;requestedUrl:string;kind:string;metadata?:unknown}
export interface CellarRepresentation {work:string;expression:string;manifestation:string;format:string;item?:string}
export interface CellarIndex {source:SourceResponse;requestedUrl:string;rows:CellarRepresentation[];work:string;language:'NL'|'EN'}
function cellarUrl(value:unknown):string {
  if(typeof value!=='string')throw new Error('Missing CELLAR resource URI.');
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.hostname!=='publications.europa.eu'||
    url.port||url.username||url.password||url.search||url.hash||
    !/^\/resource\/cellar\/[0-9a-f-]{36}(?:\.\d+)*(?:\/[A-Za-z0-9_.-]+)?$/i.test(url.pathname))throw new Error('Unexpected CELLAR resource URI.');
  url.protocol='https:';return url.href;
}
export async function fetchEuRepresentations(celex:string,language:'NL'|'EN'='EN',fetcher:typeof request=request):Promise<CellarIndex>{
  checkCelex(celex);
  const code=language==='EN'?'ENG':'NLD';
  const query=`PREFIX cdm: <${CDM}>
SELECT DISTINCT ?work ?expression ?language ?manifestation ?format ?item WHERE {
  ?work cdm:resource_legal_id_celex ?id . FILTER(str(?id) = ${JSON.stringify(celex)})
  ?expression cdm:expression_belongs_to_work ?work ; cdm:expression_uses_language ?language .
  FILTER(?language = <http://publications.europa.eu/resource/authority/language/${code}>)
  ?manifestation cdm:manifestation_manifests_expression ?expression ; cdm:manifestation_type ?format .
  OPTIONAL { ?item cdm:item_belongs_to_manifestation ?manifestation . }
} ORDER BY ?format ?item LIMIT 1000`;
  const url=new URL('https://publications.europa.eu/webapi/rdf/sparql');
  url.searchParams.set('query',query);url.searchParams.set('format','application/sparql-results+json');
  const source=await fetcher(url.href,{Accept:'application/sparql-results+json'});
  const bindings=JSON.parse(source.text).results?.bindings;
  if(!Array.isArray(bindings)||bindings.length>=1000)throw new Error('Incomplete EU representation index.');
  if(!bindings.length)throw new Error(`No ${code} expressions in CELLAR representation index.`);
  const rows:CellarRepresentation[]=bindings.map(row=>{
    if(row.language?.value!==`http://publications.europa.eu/resource/authority/language/${code}`)throw new Error('Wrong language in CELLAR representation index.');
    const work=cellarUrl(row.work?.value),expression=cellarUrl(row.expression?.value),manifestation=cellarUrl(row.manifestation?.value);
    const format=row.format?.value,item=row.item===undefined?undefined:cellarUrl(row.item.value);
    if(!/\/resource\/cellar\/[0-9a-f-]{36}$/i.test(new URL(work).pathname)||
      !expression.startsWith(work+'.')||!/^\.\d+$/.test(expression.slice(work.length))||
      !manifestation.startsWith(expression+'.')||!/^\.\d+$/.test(manifestation.slice(expression.length))||
      typeof format!=='string'||!/^[a-z0-9_-]+$/.test(format)||item&&!item.startsWith(manifestation+'/'))throw new Error('Inconsistent CELLAR WEMI identity.');
    return {work,expression,manifestation,format,...item?{item}:{}};
  });
  if(new Set(rows.map(r=>r.work)).size!==1||new Set(rows.map(r=>r.expression)).size!==1)throw new Error('Ambiguous CELLAR work/expression for requested CELEX.');
  return {source,requestedUrl:url.href,rows,work:rows[0].work,language};
}
export function createEuSourceLoader(fetcher:(doc:EuDocument)=>Promise<EuSource> = fetchEuText):(doc:EuDocument)=>Promise<EuSource>{
  const load=shareInFlight(key=>{const [celex,include]=JSON.parse(key);return fetcher({celex,include,metadata:{},role:'source'});});
  return doc=>load(JSON.stringify([doc.celex,doc.include]));
}
export async function fetchEuText(doc: EuDocument, language:'NL'|'EN'='EN'): Promise<EuSource> {
  checkCelex(doc.celex);
  const urls = [
    `https://publications.europa.eu/resource/celex/${encodeURIComponent(doc.celex)}`,
    `https://eur-lex.europa.eu/legal-content/${language}/TXT/HTML/?uri=${encodeURIComponent('CELEX:' + doc.celex)}`,
  ];
  let last: unknown,indexPromise:Promise<CellarIndex>|undefined;
  const getIndex=():Promise<CellarIndex>=>{
    if(!indexPromise){const pending=fetchEuRepresentations(doc.celex,language);indexPromise=pending;
      void pending.catch(()=>{if(indexPromise===pending)indexPromise=undefined;});}
    return indexPromise;
  };
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const response = await request(url, { Accept: 'application/xhtml+xml,text/html;q=0.9', 'Accept-Language': language==='EN'?'eng':'nld' });
      const parsed=parseEuSource(response, doc.include, language);
      return await nativeEuSource(doc,response,url,parsed,language,undefined,getIndex);
    } catch (error) { if(error instanceof XmlValidationInfrastructureError)throw error;last = error; failures.push(String(error)); }
  }
  // Resolve the official language-specific streams, also retaining this index
  // for metadata/Formex retrieval rather than repeating a second discovery.
  try {
    const index=await getIndex();
    const candidates=[...new Set(index.rows.filter(r=>['xhtml','html','html_simplified','xhtml_simplified'].includes(r.format)).flatMap(r=>r.item?[r.item]:[]))];
    for (const item of candidates) {
      try {
        const source = await request(item, { Accept: 'application/xhtml+xml,text/html;q=0.9' });
        const parsed=parseEuSource(source, doc.include, language);
        return await nativeEuSource(doc,source,item,parsed,language,index,getIndex);
      } catch (error) { if(error instanceof XmlValidationInfrastructureError)throw error;last = error; }
    }
  } catch (error) { if(error instanceof XmlValidationInfrastructureError)throw error;last = error; }
  throw new Error(`Unable to retrieve complete ${language} EU source ${doc.celex}: ${failures.join('; ')}; stream: ${String(last)}`);
}

async function checkedNotice(source:SourceResponse,kind:XmlKind,check:()=>void,identifier?:string){
  const xmlValidation=await validateSourceXml(source,kind,identifier);
  try{check();}catch(error){preserveRejectedSource(source,kind,'REPRESENTATION_REJECTED');throw error;}
  return xmlValidation;
}
export async function fetchRdfNotice(base:string,fetcher:typeof request=request,language:'NL'|'EN'='EN',identifier?:string):Promise<{source:SourceResponse;kind:string;warning?:string;xmlValidation?:XmlReceipt}>{
  let treeError:unknown;
  try{
    const source=await fetcher(base,{Accept:'application/rdf+xml;notice=tree'});
    const xmlValidation=await checkedNotice(source,'CELLAR-RDF-tree',()=>{
      if(!xmlObject(source.bytes).RDF)throw new Error('Expected a CELLAR RDF tree notice.');
    },identifier);
    return {source,kind:'CELLAR-RDF-tree',...xmlValidation?{xmlValidation}:{}};
  }catch(error){if(error instanceof XmlValidationInfrastructureError)throw error;treeError=error;}
  let branchError:unknown;
  try{
    const source=await fetcher(base,{Accept:'application/xml;notice=branch','Accept-Language':language==='EN'?'eng':'nld'});
    const xmlValidation=await checkedNotice(source,'CELLAR-XML-branch',()=>{
    const notice=xmlObject(source.bytes).NOTICE;
    const lang=notice?.EXPRESSION?.LANG;
    const values=(Array.isArray(lang)?lang:[lang]).map(v=>v?.VALUE);
    const accepted=language==='EN'?['en','eng']:['nl','nld'];
    if(notice?.['@_type']!=='branch'||!notice.WORK||!notice.EXPRESSION||!values.length||values.some(v=>!accepted.includes(v)))throw new Error('Expected a CELLAR XML branch in the requested language.');
    });
    return {source,kind:'CELLAR-XML-branch',...xmlValidation?{xmlValidation}:{},warning:`Full RDF tree unavailable: ${treeError instanceof Error?treeError.message:'retrieval failed'}; ${language} XML branch retained (work, expression and manifestations).`};
  }catch(error){if(error instanceof XmlValidationInfrastructureError)throw error;branchError=error;}
  const source=await fetcher(base,{Accept:'application/rdf+xml;notice=non-inferred'});
  const xmlValidation=await checkedNotice(source,'CELLAR-RDF-object',()=>{
    if(!xmlObject(source.bytes).RDF)throw new Error('Expected a CELLAR RDF object notice.');
  },identifier);
  return {source,kind:'CELLAR-RDF-object',...xmlValidation?{xmlValidation}:{},warning:`Full RDF tree unavailable: ${treeError instanceof Error?treeError.message:'retrieval failed'}; XML branch unavailable: ${branchError instanceof Error?branchError.message:'retrieval failed'}; non-inferred object notice retained (work metadata only).`};
}

async function nativeEuSource(doc:EuDocument,html:SourceResponse,requestedUrl:string,parsed:EuText,language:'NL'|'EN',index?:CellarIndex,indexLoader:()=>Promise<CellarIndex>=()=>fetchEuRepresentations(doc.celex,language)):Promise<EuSource>{
  let base=`https://publications.europa.eu/resource/celex/${encodeURIComponent(doc.celex)}`;
  const prefix=doc.celex.replace(/[^A-Za-z0-9_.-]/g,'_');
  const nativeSources:NativeEuSource[]=[{name:doc.celex.replace(/[^A-Za-z0-9_.-]/g,'_')+'.xhtml',source:html,requestedUrl,kind:'CELLAR-XHTML',metadata:{celex:doc.celex,language,include:doc.include}}];
  const nativeWarnings:string[]=[];
  const nativeIssues:SourceIssue[]=[];
  const warn=(code:string,classification:SourceIssue['classification'],representation:string,message:string)=>{
    nativeWarnings.push(message);nativeIssues.push({code,classification,representation,message,documentId:doc.celex});
  };
  try{
    index??=await indexLoader();base=index.work;
    nativeSources.push({name:prefix+'.formats.json',source:index.source,requestedUrl:index.requestedUrl,kind:'CELLAR-WEMI-index',metadata:{celex:doc.celex,language,work:index.work,rows:index.rows}});
  }catch(error){warn('WEMI_INDEX_UNAVAILABLE','METADATA_INCOMPLETE','WEMI',`${doc.celex} format index unavailable: ${error instanceof Error?error.message:'retrieval failed'}; availability cannot be determined.`);}
  assertEuSourceIdentity(html.text,html.url,doc.celex,index);
  // A metadata notice is independent of XHTML; requesting XHTML never implies
  // automatic RDFa enrichment.
  try{
    const rdf=await fetchRdfNotice(base,request,language,doc.celex);
    nativeSources.push({name:prefix+(rdf.kind==='CELLAR-XML-branch'?'.notice.xml':'.rdf.xml'),source:rdf.source,requestedUrl:base,kind:rdf.kind,metadata:{celex:doc.celex,language,...rdf.xmlValidation?{xmlValidation:rdf.xmlValidation}:{}}});
    if(rdf.warning)warn('RDF_NOTICE_FALLBACK','METADATA_INCOMPLETE','RDF',`${doc.celex} RDF notice: ${rdf.warning}`);
  }catch(error){if(error instanceof XmlValidationInfrastructureError)throw error;warn('RDF_NOTICE_UNAVAILABLE','METADATA_INCOMPLETE','RDF',`${doc.celex} RDF notice: ${error instanceof Error?error.message:'retrieval failed'}`);}
  if(index&&!index.rows.some(r=>r.format==='fmx4')){
    warn('FORMEX_NOT_PUBLISHED','NOT_OBSERVED','Formex',`${doc.celex} Formex: no ${language} fmx4 manifestation found in the successfully queried official WEMI index; unchanged XHTML retained. This is an observed empty search result, not a missing source.`);
    return {html:html.text,sourceUrl:html.url,parsed,nativeSources,nativeWarnings,nativeIssues};
  }
  let downloadedFormex:BinarySource|undefined;
  let formexStage='LOCATE';
  try{
    const manifestations=[...new Set(index?.rows.filter(r=>r.format==='fmx4').map(r=>r.manifestation)??[])];
    if(manifestations.length>1)throw new Error('Ambiguous Formex manifestations; not choosing a version arbitrarily.');
    const formexUrl=manifestations[0]??base;
    formexStage='RETRIEVE';
    const zip=await fetchBinarySource(formexUrl,{Accept:'application/zip;mtype=fmx4','Accept-Language':language==='EN'?'eng':'nld'},
      {cacheDir:process.env.LAW_SOURCE_CACHE_DIR,timeoutMs:60_000,allowedHosts:['publications.europa.eu'],maxBytes:64_000_000});
    downloadedFormex=zip;
    formexStage='VALIDATE';
    const xmlValidation=await validateFormexXml(zip);
    const info=formexInfo(zip.bytes,doc.celex,zip.url);
    if(!info.members.some(n=>n.includes(language)))throw new Error('Formex package does not identify the requested language.');
    nativeSources.push({name:prefix+'.fmx4.zip',source:zip,requestedUrl:formexUrl,kind:'CELLAR-Formex4',metadata:{...info,celex:doc.celex,language,...xmlValidation?{xmlValidation}:{}}});
  }catch(error){
    if(error instanceof XmlValidationInfrastructureError)throw error;
    if(downloadedFormex)preserveRejectedSource(downloadedFormex,'CELLAR-Formex4','FORMEX_REPRESENTATION_REJECTED');
    warn(downloadedFormex?'FORMEX_REJECTED':formexStage==='RETRIEVE'?'FORMEX_RETRIEVAL_FAILED':'FORMEX_LOCATION_FAILED',
      downloadedFormex?'REPRESENTATION_REJECTED':formexStage==='RETRIEVE'?'SOURCE_UNAVAILABLE':'METADATA_INCOMPLETE',
      'Formex',`${doc.celex} Formex: ${error instanceof Error?error.message:'representation operation failed'}; unchanged XHTML retained.`);
  }
  return {html:html.text,sourceUrl:html.url,parsed,nativeSources,nativeWarnings,nativeIssues};
}
