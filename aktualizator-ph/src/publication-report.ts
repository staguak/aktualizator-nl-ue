import {isDeepStrictEqual} from 'node:util';
import {validateManifest,validatePointer,validateContext} from './release-engine.js';
import type {ActivePointer,RunContext} from './release-engine.js';
import {hash} from './release-store.js';
import type {ReleaseStore} from './release-store.js';

export interface PublicationReport {
  profile:'paired-publication-report-v1';status:'COMMITTED_AND_RETENTION_VERIFIED';
  runId:string;releaseId:string;codeRevision:string;configSha256:string;parentReleaseId:string|null;baseId:string;
  pointerSha256:string;manifestSha256:string;baseManifestSha256:string;
  range:{from:string;to:string;observedOn:string};
  moduleBuildReports:{jurisdiction:'NL'|'EU';key:string;sha256:string;profile:'module-build-report-v1'|'LEGACY_UNSTRUCTURED_REPORT'}[];
  retention:{key:string;sha256:string};
  scope:'Completed commit and verified retention; immutable module reports remain unchanged; not an independent backup service or legal-history completeness claim';
}
export async function publicationReport(store:ReleaseStore,context:RunContext,active:ActivePointer,retention:{key:string;sha256:string}):Promise<PublicationReport>{
  validateContext(context);validatePointer(active);
  if(active.releaseId!==context.releaseId||active.operationId!==context.runId||active.baseId!==context.baseId)throw new Error('Publication report operation mismatch.');
  const pointer=await store.read('active.json');
  if(!pointer||!isDeepStrictEqual(JSON.parse(pointer.toString()),active))throw new Error('Publication report active changed.');
  const raw=await store.read(active.manifestKey);if(!raw||hash(raw)!==active.manifestSha256)throw new Error('Publication report root changed.');
  const manifest=JSON.parse(raw.toString());validateManifest(manifest);
  if(!isDeepStrictEqual(manifest.context,context))throw new Error('Publication report context changed.');
  const moduleBuildReports:PublicationReport['moduleBuildReports']=[];
  for(const jurisdiction of ['NL','EU'] as const){
    const file=manifest.files.find(f=>f.jurisdiction===jurisdiction&&f.name==='REPORT.md');
    const moduleFile=manifest.files.find(f=>f.jurisdiction===jurisdiction&&f.name==='manifest.json');
    if(!file||!moduleFile)throw new Error('Publication report is missing a module report.');
    const bytes=await store.read(file.key),moduleBytes=await store.read(moduleFile.key);
    if(!bytes||hash(bytes)!==file.sha256||!moduleBytes||hash(moduleBytes)!==moduleFile.sha256)throw new Error('Publication report module evidence changed.');
    const module=JSON.parse(moduleBytes.toString());
    const parsed=[...bytes.toString().matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)]
      .map(match=>JSON.parse(match[1])).filter(value=>value.profile==='module-build-report-v1');
    if(parsed.length>1||!parsed.length&&module.acts?.some((a:any)=>a.sourceArchive?.reportEvidence))throw new Error('Missing or duplicate structured module report.');
    if(parsed.length){
      const build=parsed[0];
      if(build.jurisdiction!==jurisdiction||build.identity?.releaseId!==context.releaseId||build.identity?.baseId!==context.baseId||
        build.identity?.parentReleaseId!==context.parentReleaseId||build.identity?.codeRevision!==context.codeRevision||build.identity?.configSha256!==context.configSha256||
        !isDeepStrictEqual(build.range,{from:context.rangeFrom,to:context.rangeTo,observedOn:context.observedOn})||build.validation?.status!=='PASS')
        throw new Error('Structured module report context/validation mismatch.');
    }
    moduleBuildReports.push({jurisdiction,key:file.key,sha256:file.sha256,profile:parsed.length?'module-build-report-v1':'LEGACY_UNSTRUCTURED_REPORT'});
  }
  const report:PublicationReport={profile:'paired-publication-report-v1',status:'COMMITTED_AND_RETENTION_VERIFIED',runId:context.runId,releaseId:context.releaseId,
    codeRevision:context.codeRevision,configSha256:context.configSha256,parentReleaseId:context.parentReleaseId,baseId:context.baseId,
    pointerSha256:hash(pointer),manifestSha256:active.manifestSha256,baseManifestSha256:active.baseManifestSha256,
    range:{from:context.rangeFrom,to:context.rangeTo,observedOn:context.observedOn},moduleBuildReports,retention,
    scope:'Completed commit and verified retention; immutable module reports remain unchanged; not an independent backup service or legal-history completeness claim'};
  await verifyPublicationReport(store,report,context,active);return report;
}
export async function verifyPublicationReport(store:ReleaseStore,report:PublicationReport,context:RunContext,active:ActivePointer):Promise<void>{
  if(!report||report.profile!=='paired-publication-report-v1'||report.status!=='COMMITTED_AND_RETENTION_VERIFIED'||
    report.runId!==context.runId||report.releaseId!==active.releaseId||report.baseId!==active.baseId||report.parentReleaseId!==context.parentReleaseId||
    report.codeRevision!==context.codeRevision||report.configSha256!==context.configSha256||report.manifestSha256!==active.manifestSha256||
    report.baseManifestSha256!==active.baseManifestSha256||!isDeepStrictEqual(report.range,{from:context.rangeFrom,to:context.rangeTo,observedOn:context.observedOn})||
    !/^checks\/retention\/[A-Za-z0-9_-]+\.json$/.test(report.retention?.key??'')||!/^[a-f0-9]{64}$/.test(report.retention?.sha256??''))throw new Error('Invalid publication completion report.');
  const pointer=await store.read('active.json');if(!pointer||hash(pointer)!==report.pointerSha256||!isDeepStrictEqual(JSON.parse(pointer.toString()),active))throw new Error('Publication report pointer changed.');
  const root=await store.read(active.manifestKey);if(!root||hash(root)!==active.manifestSha256)throw new Error('Publication report root changed.');
  const manifest=JSON.parse(root.toString());validateManifest(manifest);
  if(!isDeepStrictEqual(manifest.context,context))throw new Error('Publication report context changed.');
  const bytes=await store.read(report.retention.key);if(!bytes||hash(bytes)!==report.retention.sha256)throw new Error('Publication retention evidence missing or corrupted.');
  const retention=JSON.parse(bytes.toString());
  if(retention.profile!=='release-retention-v1'||retention.releaseId!==active.releaseId||retention.operationId!==active.operationId||
    retention.baseId!==active.baseId||retention.baseManifestSha256!==active.baseManifestSha256||!Array.isArray(retention.retainedRecovery)||
    retention.retainedRecovery.length>2||!Array.isArray(retention.protectedReleaseIds)||!retention.protectedReleaseIds.includes(active.releaseId)||
    !Number.isSafeInteger(retention.graceMs)||retention.graceMs<72*3600*1000)throw new Error('Publication retention evidence context mismatch.');
  const ids=new Set([active.releaseId]);
  for(const previous of retention.retainedRecovery){
    validatePointer(previous);
    if(ids.has(previous.releaseId)||previous.baseId!==active.baseId||previous.baseManifestSha256!==active.baseManifestSha256||!retention.protectedReleaseIds.includes(previous.releaseId))throw new Error('Publication backup context mismatch.');
    ids.add(previous.releaseId);
  }
  if(!Array.isArray(report.moduleBuildReports)||report.moduleBuildReports.length!==2||new Set(report.moduleBuildReports.map(m=>m.jurisdiction)).size!==2)throw new Error('Invalid publication module report references.');
  for(const module of report.moduleBuildReports){
    if(!['NL','EU'].includes(module.jurisdiction)||module.key!==`releases/${active.releaseId}/${module.jurisdiction}/REPORT.md`||!['module-build-report-v1','LEGACY_UNSTRUCTURED_REPORT'].includes(module.profile)||!/^[a-f0-9]{64}$/.test(module.sha256))throw new Error('Invalid publication module reference.');
    if(manifest.files.find(f=>f.key===module.key)?.sha256!==module.sha256)throw new Error('Publication module report differs from committed anchor.');
    const raw=await store.read(module.key);if(!raw||hash(raw)!==module.sha256)throw new Error('Publication module report changed.');
  }
}
