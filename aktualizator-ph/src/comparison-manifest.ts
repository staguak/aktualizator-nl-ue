import {hash} from './release-store.js';
import type {ReleaseStore} from './release-store.js';
import {validateManifest} from './release-engine.js';
import type {ReleaseManifest} from './release-engine.js';
import {loadSourceArchive} from './official-sources.js';
import {sourceReportEvidence,validateSourceReportEvidence} from './source-report-evidence.js';

// Upgrade only the local comparison view. Never write to an old generation,
// its module manifest, active or immutable base. Once new releases carry the
// compact index, subsequent comparisons need only the anchored manifest.
export async function comparisonManifest(store:ReleaseStore,previous:ReleaseManifest,module:'NL'|'EU'){
  validateManifest(previous);
  const file=previous.files.find(f=>f.jurisdiction===module&&f.name==='manifest.json');
  if(!file)throw new Error('Missing predecessor comparison manifest.');
  const bytes=await store.read(file.key);
  if(!bytes||hash(bytes)!==file.sha256)throw new Error('Previous comparison manifest changed.');
  const value=JSON.parse(bytes.toString());
  const end=previous.kind==='base'?previous.context.rangeFrom:previous.context.rangeTo;
  if(value.jurisdiction!==module||value.rangeFrom!==previous.context.rangeFrom||value.rangeTo!==end||!Array.isArray(value.acts))throw new Error('Comparison predecessor scope mismatch.');
  const backfilled:{name:string;key:string;sha256:string}[]=[];
  for(const act of value.acts){
    const archive=act.sourceArchive;
    if(!archive)continue;
    if(archive.reportEvidence!==undefined){validateSourceReportEvidence(archive.reportEvidence);continue;}
    const source=previous.files.find(f=>f.jurisdiction===module&&f.name===archive.name);
    if(!source)throw new Error('Missing predecessor source comparison file.');
    const native=await store.read(source.key);
    if(!native||hash(native)!==source.sha256)throw new Error('Previous source comparison archive changed.');
    const {index,items}=loadSourceArchive(native,archive,module,act.bwbId??act.celex);
    archive.reportEvidence=sourceReportEvidence(index,items);
    backfilled.push({name:archive.name,key:source.key,sha256:source.sha256});
  }
  value.sourceReportComparison={profile:'anchored-predecessor-report-v1',generationKind:previous.kind,
    releaseId:previous.kind==='base'?null:previous.context.releaseId,baseId:previous.context.baseId,
    manifestSha256:file.sha256,backfilled,scope:'Local comparison view only; predecessor data and hashes remain unchanged'};
  return value;
}
