import * as path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { VersionRecord } from './types.js';
import { fetchSource,retrySource } from './source-cache.js';
import {operationMetrics} from './operation-metrics.js';
import type { SourceResponse } from './source-cache.js';
import { OfficialSources, xmlObject } from './official-sources.js';
import {observeUnits,observeWti} from './unit-observations.js';
import { isCalendarDate } from './calendar.js';
import {validateSourceXml,XmlValidationInfrastructureError} from './xml-validation.js';
import {isDeepStrictEqual} from 'node:util';

const SRU_BASE = 'https://zoekservice.overheid.nl/sru/Search';
const DEFAULT_RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS ?? '1000');
const MAX_RETRIES = 5;
const PAGE_SIZE = 100;
const HTTP_CACHE_DIR = process.env.LAW_HTTP_CACHE_DIR
  ? path.resolve(process.cwd(), process.env.LAW_HTTP_CACHE_DIR)
  : null;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchResponseWithRetry(url: string,unconditional=false): Promise<SourceResponse> {
  return retrySource(()=>fetchSource(url,{'User-Agent':'NL-Law-Updater/1.0',Accept:'application/xml',
    ...unconditional?{'Cache-Control':'no-cache',Pragma:'no-cache'}:{}},
    {cacheDir:unconditional?undefined:process.env.LAW_SOURCE_CACHE_DIR??(HTTP_CACHE_DIR?path.join(HTTP_CACHE_DIR,'revalidated-v1'):undefined),
      timeoutMs:45_000,allowedHosts:['zoekservice.overheid.nl','repository.officiele-overheidspublicaties.nl']}),MAX_RETRIES);
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function versionKeyFromUrl(url: string): string {
  const match = url.match(/\/(\d{4}-\d{2}-\d{2})_(\d+)\//);
  return match ? `${match[1]}_${match[2]}` : url;
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}

export function parseSru(xml: string): {
  records: VersionRecord[];
  nextRecordPosition: number | null;
  numberOfRecords: number | null;
  rawRecordCount: number;
  recordPositions: (number|null)[];
} {
  const parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });
  const doc = parser.parse(xml) as Record<string, unknown>;
  const root = doc.searchRetrieveResponse as Record<string, unknown> | undefined;
  if (!root || root.diagnostics) throw new Error('Invalid SRU response or SRU diagnostic.');

  const recordsContainer = root.records as Record<string, unknown> | undefined;
  const rawRecords = toArray(recordsContainer?.record);
  const records: VersionRecord[] = [];
  const recordPositions:(number|null)[]=[];

  for (const raw of rawRecords) {
    if (!raw || typeof raw !== 'object') throw new Error('Malformed SRU record.');
    const positionValue=(raw as Record<string,unknown>).recordPosition;
    const position=positionValue===undefined?null:Number(positionValue);
    if(position!==null&&(!Number.isSafeInteger(position)||position<1))throw new Error('Invalid SRU record position.');
    recordPositions.push(position);
    const recordData = (raw as Record<string, unknown>).recordData as Record<string, unknown> | undefined;
    const gzd = recordData?.gzd as Record<string, unknown> | undefined;
    if (!gzd) throw new Error('Missing SRU BWB record data.');

    const enriched = gzd.enrichedData as Record<string, unknown> | undefined;
    const toestandUrl = textValue(enriched?.locatie_toestand);
    if (!toestandUrl) throw new Error('Missing SRU Toestand location.');

    const original = gzd.originalData as Record<string, unknown> | undefined;
    const meta = original?.meta as Record<string, unknown> | undefined;
    const bwbipm = meta?.bwbipm as Record<string, unknown> | undefined;

    const validFrom = textValue(bwbipm?.geldigheidsperiode_startdatum);
    const validTo = textValue(bwbipm?.geldigheidsperiode_einddatum);

    records.push({
      key: versionKeyFromUrl(toestandUrl),
      toestandUrl,
      validFrom,
      validTo,
      visibleFrom: textValue(bwbipm?.zichtperiode_startdatum),
      visibleTo: textValue(bwbipm?.zichtperiode_einddatum),
      wtiUrl: textValue(enriched?.locatie_wti),
      manifestUrl: textValue(enriched?.locatie_manifest),
    });
  }

  const totalRaw = root.numberOfRecords;
  const numberOfRecords =
    typeof totalRaw === 'number'
      ? totalRaw
      : typeof totalRaw === 'string' && totalRaw.trim()
        ? Number(totalRaw)
        : null;

  const nextRaw = root.nextRecordPosition;
  const nextRecordPosition =
    typeof nextRaw === 'number'
      ? nextRaw
      : typeof nextRaw === 'string' && nextRaw.trim()
        ? Number(nextRaw)
        : null;

  if(numberOfRecords!==null&&(!Number.isSafeInteger(numberOfRecords)||numberOfRecords<0)||
    nextRecordPosition!==null&&(!Number.isSafeInteger(nextRecordPosition)||nextRecordPosition<1))
    throw new Error('Invalid SRU pagination counters.');

  return {
    records,
    nextRecordPosition:
      nextRecordPosition != null && Number.isFinite(nextRecordPosition)
        ? nextRecordPosition
        : null,
    numberOfRecords:
      numberOfRecords != null && Number.isFinite(numberOfRecords)
        ? numberOfRecords
        : null,
    rawRecordCount: rawRecords.length,
    recordPositions,
  };
}

export async function discoverVersions(bwbId: string, archive?: OfficialSources, fetcher:typeof fetchResponseWithRetry=fetchResponseWithRetry,wait:typeof sleep=sleep): Promise<VersionRecord[]> {
  const collected: VersionRecord[] = [];
  const acceptedStates=new Map<string,VersionRecord>(),declaredCounts=new Set<number>();
  let startRecord = 1;
  let probingContinuation = false;
  const seenStarts = new Set<number>();

  while (true) {
    if (seenStarts.has(startRecord)) {
      throw new Error(`SRU pagination loop for ${bwbId} at ${startRecord}`);
    }
    seenStarts.add(startRecord);

    const url = new URL(SRU_BASE);
    url.searchParams.set('operation', 'searchRetrieve');
    url.searchParams.set('version', '2.0');
    url.searchParams.set('httpAccept', 'application/xml');
    url.searchParams.set('x-connection', 'BWB');
    url.searchParams.set('query', `dcterms.identifier=${bwbId}`);
    url.searchParams.set('maximumRecords', String(PAGE_SIZE));
    url.searchParams.set('startRecord', String(startRecord));

    let parsed: ReturnType<typeof parseSru> | null = null;

    for (let pageAttempt = 1; pageAttempt <= MAX_RETRIES; pageAttempt++) {
      if(pageAttempt>1)operationMetrics.add('sourceRetries');
      const response = await fetcher(url.toString(),pageAttempt>1);
      const xmlValidation=await validateSourceXml(response,'SRU-2.0');
      const candidate = parseSru(response.text);

      const pageShouldContainRecords =
        probingContinuation ||
        (candidate.numberOfRecords != null &&
          startRecord <= candidate.numberOfRecords);
      const pageStates=new Map<string,VersionRecord>();let repeated=false,contradictory=false;
      for(const record of candidate.records){
        const previous=pageStates.get(record.toestandUrl)??acceptedStates.get(record.toestandUrl);
        if(previous){if(isDeepStrictEqual(previous,record))repeated=true;else contradictory=true;}
        pageStates.set(record.toestandUrl,record);
      }
      const accepted=!repeated&&!contradictory&&(candidate.rawRecordCount>0||!pageShouldContainRecords);
      // A retry is a separate observation, not a mutation of an already saved
      // source. Keep both the empty response and the later accepted page.
      archive?.add(`sru/${startRecord}-attempt-${pageAttempt}.xml`,response,url.toString(),'SRU-2.0',
        {startRecord,attempt:pageAttempt,accepted,...repeated?{rejection:'REPEATED_SOURCE_STATES'}:{},records:candidate.records,rawRecordCount:candidate.rawRecordCount,
          numberOfRecords:candidate.numberOfRecords,nextRecordPosition:candidate.nextRecordPosition,
          recordPositions:candidate.recordPositions,...xmlValidation?{xmlValidation}:{}});
      if(candidate.recordPositions.some((position,index)=>position!==null&&position!==startRecord+index)){
        archive?.preserveDiagnostic('NL_DISCOVERY_FAILED');
        throw new Error(`SRU record positions do not match requested page for ${bwbId} at ${startRecord}.`);
      }
      if(contradictory){archive?.preserveDiagnostic('NL_DISCOVERY_FAILED');throw new Error(`Contradictory SRU state observations for ${bwbId}.`);}
      if (accepted) {
        parsed = candidate;
        break;
      }

      if (pageAttempt < MAX_RETRIES) {
        console.warn(
          `SRU returned ${repeated?'repeated source states':'an unexpectedly empty page'} for ${bwbId} at ${startRecord}; retrying unconditionally (${pageAttempt}/${MAX_RETRIES})`,
        );
        await wait(1500 * pageAttempt);
      } else {
        if(repeated){archive?.preserveDiagnostic('NL_DISCOVERY_FAILED');throw new Error(`SRU repeated source states across pagination for ${bwbId} at ${startRecord}.`);}
        parsed = candidate;
      }
    }

    if (!parsed) {
      throw new Error(`SRU page retrieval failed for ${bwbId} at ${startRecord}`);
    }

    for(const record of parsed.records){
      const location=new URL(record.toestandUrl);
      if(location.protocol!=='https:'||location.hostname!=='repository.officiele-overheidspublicaties.nl'||
        location.username||location.password||!location.pathname.startsWith(`/bwb/${bwbId}/`))
        throw new Error(`SRU returned an unexpected Toestand identity for ${bwbId}.`);
    }
    collected.push(...parsed.records);
    for(const record of parsed.records)acceptedStates.set(record.toestandUrl,record);
    if(parsed.numberOfRecords!==null)declaredCounts.add(parsed.numberOfRecords);

    let next = parsed.nextRecordPosition;
    let nextWasSpeculative = false;

    // Some SRU responses intermittently omit nextRecordPosition even though
    // numberOfRecords says that more pages exist. Never silently accept a
    // truncated version history: derive the next page from the number of raw
    // records returned by this page.
    const consumedThrough = startRecord - 1 + parsed.rawRecordCount;
    if (
      next == null &&
      parsed.numberOfRecords != null &&
      consumedThrough < parsed.numberOfRecords
    ) {
      if (parsed.rawRecordCount === 0) {
        throw new Error(
          `SRU truncated pagination for ${bwbId}: expected ${parsed.numberOfRecords} records but page at ${startRecord} stayed empty after ${MAX_RETRIES} attempts`,
        );
      }
      next = startRecord + parsed.rawRecordCount;
      console.warn(
        `SRU omitted nextRecordPosition for ${bwbId}; continuing at ${next} using numberOfRecords=${parsed.numberOfRecords}`,
      );
    }

    // Some SRU responses incorrectly report exactly one full page and omit
    // both a truthful total and nextRecordPosition. A full page is therefore
    // treated as a reason to probe the next page. If that probe remains empty
    // after the normal retries, pagination ends cleanly.
    if (next == null && parsed.rawRecordCount === PAGE_SIZE) {
      next = startRecord + parsed.rawRecordCount;
      nextWasSpeculative = true;
      console.warn(
        'SRU returned a full page without continuation for ' + bwbId +
          '; probing at ' + next,
      );
    }

    if (next == null) break;
    if (next <= startRecord) {
      throw new Error(
        `SRU nextRecordPosition did not advance for ${bwbId}: ${next}`,
      );
    }
    startRecord = next;
    probingContinuation = nextWasSpeculative;
    await wait(DEFAULT_RATE_LIMIT_MS);
  }

  const unique = new Map<string, VersionRecord>();
  for (const version of collected){
    const previous=unique.get(version.toestandUrl);
    if(previous&&!isDeepStrictEqual(previous,version))throw new Error(`Contradictory SRU state observations for ${bwbId}.`);
    unique.set(version.toestandUrl, version);
  }
  if([...declaredCounts].some(count=>unique.size<count)){
    archive?.preserveDiagnostic('NL_DISCOVERY_FAILED');throw new Error(`Incomplete SRU unique-state coverage for ${bwbId}.`);
  }
  archive?.completeDiscovery({protocol:'SRU-2.0',pages:[...seenStarts],discoveredStates:unique.size,
    declaredCounts:[...declaredCounts].sort((a,b)=>a-b),duplicatePolicy:'Repeated source states rejected before page acceptance',
    scope:'Configured BWB identifier; completed pagination, not a claim about unknown source records.'});

  return [...unique.values()].sort((a, b) => {
    const da = a.validFrom ?? '';
    const db = b.validFrom ?? '';
    if (da !== db) return da.localeCompare(db);
    return a.key.localeCompare(b.key);
  });
}

export function overlapsRange(
  version: VersionRecord,
  rangeFrom: string,
  rangeTo: string,
): boolean {
  if (version.validFrom && version.validFrom > rangeTo) return false;
  if (version.validTo && version.validTo < rangeFrom) return false;
  return true;
}

export async function fetchVersionXml(url: string, archive?: OfficialSources, version?: VersionRecord): Promise<string> {
  return (await fetchVersionSource(url,archive,version)).text;
}
export async function fetchVersionSource(url:string,archive?:OfficialSources,version?:VersionRecord):Promise<SourceResponse>{
  const response = await fetchResponseWithRetry(url);
  const identifier=archive?.identifier??url.match(/\bBWBR\d{7}\b/)?.[0];
  const xmlValidation=await validateSourceXml(response,'BWB-Toestand',identifier);
  const history=archive?observeUnits(response.bytes,{jurisdiction:'NL',documentId:archive.identifier,url:response.url}):undefined;
  if(archive)archive.add(`toestand/${versionKeyFromUrl(url).replace(/[^A-Za-z0-9_.-]/g,'_')}.xml`,response,url,'BWB-Toestand',
    {version,units:history!.units,unitHistoryProfile:history!.profile,unitHistorySource:history!.source,unitCorrections:history!.corrections,...xmlValidation?{xmlValidation}:{}});
  await sleep(DEFAULT_RATE_LIMIT_MS);
  return response;
}

export async function fetchBwbAuxiliary(version:VersionRecord,archive:OfficialSources):Promise<void>{
  for(const [kind,url]of [['WTI',version.wtiUrl],['manifest',version.manifestUrl]] as const){
    if(!url){archive.warning(`BWB ${kind}: URL absent from SRU.`,{classification:'METADATA_INCOMPLETE',code:'BWB_AUXILIARY_URL_ABSENT',representation:kind,documentId:archive.identifier});continue;}
    try{
      const source=await fetchResponseWithRetry(url);
      const identifier=archive.identifier;
      const xmlValidation=await validateSourceXml(source,`BWB-${kind}`,identifier);
      xmlObject(source.bytes);archive.add(`bwb/${kind}.xml`,source,url,`BWB-${kind}`,{
        ...xmlValidation?{xmlValidation}:{},...kind==='WTI'?{wtiHistory:observeWti(source.bytes,
          {jurisdiction:'NL',documentId:archive.identifier,url:source.url},archive.range)}:{}});
    }catch(error){if(error instanceof XmlValidationInfrastructureError)throw error;archive.warning(`BWB ${kind}: ${error instanceof Error?error.message:'retrieval failed'}`,
      {classification:'METADATA_INCOMPLETE',code:'BWB_AUXILIARY_RETRIEVAL_FAILED',representation:kind,documentId:archive.identifier});}
  }
}

// Query date g and visibility date z are independent. Select published states
// visible at z that intersect the requested interval g. Do not manufacture a
// future fallback or a baseline belonging to a wholly expired regulation.
export function selectBwbVersions(versions:VersionRecord[],from:string,to:string,observedOn:string,archive?:OfficialSources):VersionRecord[]{
  try{
  if(![from,to,observedOn].every(isCalendarDate)||from>to||to>observedOn)throw new Error('Invalid BWB selection dates.');
  const selected=versions.filter(v=>{
    if(!v.validFrom||!isCalendarDate(v.validFrom)||v.validTo&&(!isCalendarDate(v.validTo)||v.validTo<v.validFrom)||
      v.visibleFrom&&!isCalendarDate(v.visibleFrom)||v.visibleTo&&!isCalendarDate(v.visibleTo)||
      v.visibleFrom&&v.visibleTo&&v.visibleTo<v.visibleFrom)throw new Error('Missing/invalid BWB state interval.');
    if(v.visibleFrom&&v.visibleFrom>observedOn||v.visibleTo&&v.visibleTo<observedOn)return false;
    return overlapsRange(v,from,to);
  }).sort((a,b)=>a.validFrom!.localeCompare(b.validFrom!)||a.key.localeCompare(b.key));
  selected.forEach((v,i)=>{if(i&&(!selected[i-1].validTo||selected[i-1].validTo!>=v.validFrom!))throw new Error('Ambiguous overlapping BWB states at the chosen visibility date.');});
  if(!selected.length)throw new Error('No BWB state intersects the requested date range.');
  return selected;
  }catch(error){archive?.preserveDiagnostic('NL_SELECTION_FAILED');throw error;}
}
