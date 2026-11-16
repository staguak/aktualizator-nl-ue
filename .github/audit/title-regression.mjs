import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

// Executed in aktualizator-ph, from the exact current main source checkout.
const sourceFile='src/eu-source-identity.ts';
const candidateFile='src/eu-source-identity-audit-candidate.ts';
const initial=fs.readFileSync(sourceFile,'utf8');
const originalLine="    const id=declaredCelex(title.replace(/^EUR-Lex\\s*-\\s*/i,'').replace(/\\s*-\\s*(?:EN|PL|NL|FR)$/i,''));";
assert.equal(initial.split(originalLine).length,2,'Production code differs; review patch before benchmarking');
const fnStart='export function assertEuSourceIdentity(';
assert.equal(initial.split(fnStart).length,2,'Expected one identity function');
const helper=`function cleanEurLexTitle(title:string):string|undefined{
  let clean=title.replace(/^EUR-Lex\\s*-\\s*/i,'');
  const match=/-\\s*(?:EN|PL|NL|FR)$/i.exec(clean);
  if(match)clean=clean.slice(0,match.index).trimEnd();
  return declaredCelex(clean);
}
`;
const candidate=initial.replace(fnStart,helper+fnStart).replace(originalLine,'    const id=cleanEurLexTitle(title);');
fs.writeFileSync(candidateFile,candidate);
const [{assertEuSourceIdentity:baseline},{assertEuSourceIdentity:proposed}]=await Promise.all([
  import('../src/eu-source-identity.ts'),import('../src/eu-source-identity-audit-candidate.ts')]);

function html(title,head=''){
  const escaped=title.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  return `<html><head><title>${escaped}</title>${head}</head><body><p>Legal document</p></body></html>`;
}
const id='32024R0001', mismatch='32025R0002';
const url='https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R0001';
const cellar='https://publications.europa.eu/resource/cellar/01234567-89ab-cdef-0123-456789abcdef/abc.xht';
const meta=`<meta name="dc.identifier" content="${id}">`;
const wrongMeta=`<meta name="dc.identifier" content="${mismatch}">`;
const cases=[
 ['bare CELEX',html(id),url,id,undefined,'PASS'],
 ['prefix CELEX',html('EUR-Lex - '+id),url,id,undefined,'PASS'],
 ['lang EN',html('EUR-Lex - '+id+' - EN'),url,id,undefined,'PASS'],
 ['lang PL',html('EUR-Lex - '+id+' - PL'),url,id,undefined,'PASS'],
 ['lang NL',html('EUR-Lex - '+id+'-NL'),url,id,undefined,'PASS'],
 ['lang FR lower',html('EUR-Lex - '+id+' - fr'),url,id,undefined,'PASS'],
 ['no-space EN',html(id+'-EN'),url,id,undefined,'PASS'],
 ['URL CELEX',html(url+' - EN'),url,id,undefined,'PASS'],
 ['URL prefix',html('EUR-Lex - '+url+' - EN'),url,id,undefined,'PASS'],
 ['mismatched CELEX',html(mismatch+' - EN'),url,id,undefined,'EU source identity mismatch'],
 ['mismatched CELEX plus good meta',html(mismatch+' - EN',meta),url,id,undefined,'EU source identity mismatch'],
 ['mismatched meta',html(id,wrongMeta),url,id,undefined,'EU source identity mismatch'],
 ['malformed title and no meta',html('EUR-Lex - not a CELEX - FR'),url,id,undefined,'EU XHTML has no independently confirmed'],
 ['malformed title with good meta',html('EUR-Lex - not a CELEX - FR',meta),url,id,undefined,'PASS'],
 ['host disallowed',html(id),'https://example.com/legal-content?id='+id,id,undefined,'Unexpected EU identity source URL'],
 ['CELLAR index valid',html('Something else'),cellar,id,{rows:[{item:cellar,format:'xhtml'}]},'PASS'],
 ['CELLAR index missing',html('Something else'),cellar,id,undefined,'EU XHTML is not bound'],
 ['CELLAR wrong format',html('Something else'),cellar,id,{rows:[{item:cellar,format:'pdf'}]},'EU XHTML is not bound'],
 ['long bad code with good meta',html('EUR-Lex - '+id+' '+' '.repeat(10000)+'-ZZ',meta),url,id,undefined,'PASS'],
 ['long valid language',html('EUR-Lex - '+id+' '+' '.repeat(10000)+'-EN'),url,id,undefined,'PASS'],
 ['consolidation valid',html('Consolidated TEXT: 32024R0001 — EN — 05.06.2024'),'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02024R0001-20240605','02024R0001-20240605',undefined,'PASS']
];
function outcome(fn,markup,sourceUrl,expected,index){
 try{fn(markup,sourceUrl,expected,index);return 'PASS';}
 catch(error){return 'ERROR:'+String(error?.message??error);}
}
let explicit=0;
for(const [name,markup,source,expected,index,expectedOutcome] of cases){
 const old=outcome(baseline,markup,source,expected,index);
 const newer=outcome(proposed,markup,source,expected,index);
 assert.equal(newer,old,`Regression in full assertEuSourceIdentity: ${name}`);
 assert.ok(old.includes(expectedOutcome),`Bad expected baseline outcome for ${name}: ${old}`);
 explicit++;
}
console.log('IDENTITY_CASES '+JSON.stringify({count:explicit,passed:explicit}));

// All calls in production receive a whitespace-normalized and trimmed title.
function cleanupBefore(title){return title.replace(/^EUR-Lex\s*-\s*/i,'').replace(/\s*-\s*(?:EN|PL|NL|FR)$/i,'');}
function cleanupAfter(title){let clean=title.replace(/^EUR-Lex\s*-\s*/i,'');const match=/-\s*(?:EN|PL|NL|FR)$/i.exec(clean);if(match)clean=clean.slice(0,match.index).trimEnd();return clean;}
const whites=['',' ','\t','\n','\r','  \t  '];
const prefixes=['','EUR-Lex - ','EUR-Lex-','eur-lex - ','CELEX:','something '];
const ids=[id,mismatch,'62024CJ0001','02024R0001-20240605','not-an-id','-EN','https://eur-lex.europa.eu/?uri=CELEX:32024R0001'];
const suffixes=['','-EN',' - PL','-FR',' - nl',' - ZZ','-EN\n',' - en ',' - XFR',' - FR\r'];
let checks=0;
for(const prefix of prefixes)for(const ident of ids)for(const suffix of suffixes)for(const whitespace of whites){
 const title=(prefix+ident+whitespace+suffix).replace(/\s+/g,' ').trim();
 assert.equal(cleanupAfter(title),cleanupBefore(title),`Cleanup changed normalized title: ${JSON.stringify(title)}`);
 checks++;
}
let seed=271828183;function rng(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
const alphabet=['A','B','-','E','N','F','R','L','P','0','3','2','\n','\t',' ',' ','_','/',';',':'];
for(let i=0;i<10000;i++){
 let title=prefixes[Math.floor(rng()*prefixes.length)];
 const len=Math.floor(rng()*110);
 for(let j=0;j<len;j++)title+=alphabet[Math.floor(rng()*alphabet.length)];
 title=title.replace(/\s+/g,' ').trim();
 assert.equal(cleanupAfter(title),cleanupBefore(title),`Cleanup drift at randomized case ${i}`);
 checks++;
}
console.log('NORMALIZED_CLEANUP_EQUIVALENCE '+JSON.stringify({checked:checks,passed:checks}));

const median=values=>{const s=[...values].sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
function time(f,repetitions=3){let sink=0;const values=[];for(let k=0;k<repetitions;k++){const start=performance.now();sink+=f().length;values.push(performance.now()-start);}return {medianMs:+median(values).toFixed(4),runs:values.map(v=>+v.toFixed(4)),sink};}
const raw=[];
for(const n of [1000,4000,10000,20000,40000]){
 const title='EUR-Lex - '+id+' '.repeat(n)+'-ZZ';
 // Long malformed suffix: baseline backtracks over overlapping whitespace.
 const before=time(()=>cleanupBefore(title));
 const after=time(()=>cleanupAfter(title));
 raw.push({spaces:n,beforeMs:before.medianMs,afterMs:after.medianMs});
}
console.log('RAW_CLEANUP_BENCH '+JSON.stringify(raw));
assert.ok(raw.at(-1).afterMs<100,'Proposed cleanup is unexpectedly slow for 40,000 whitespace characters');

const full=[];
for(const n of [1000,4000,10000,20000,40000]){
 for(const shape of ['long-whitespace','alternating-separators']){
  const title=shape==='long-whitespace'?'EUR-Lex - '+id+' '.repeat(n)+'-ZZ':
   'EUR-Lex - '+id+' - '.repeat(Math.floor(n/3))+'ZZ';
  const markup=html(title,meta);
  const old=time(()=>outcome(baseline,markup,url,id),7);
  const newer=time(()=>outcome(proposed,markup,url,id),7);
  full.push({shape,characters:markup.length,spaces:n,originalMs:old.medianMs,candidateMs:newer.medianMs});
 }
}
console.log('FULL_FUNCTION_BENCH '+JSON.stringify(full));
console.log('RUNTIME_ENV '+JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,sourceSha256:(await import('node:crypto')).createHash('sha256').update(initial).digest('hex')}));

// Only mutate the runner checkout for typecheck and full project test suite.
fs.writeFileSync(sourceFile,candidate);
console.log('AUDIT_PATCHED_RUNNER_CHECKOUT_ONLY');
