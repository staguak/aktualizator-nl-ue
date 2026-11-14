import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {extractEuAssets} from './eu-assets.js';
import {assertEuAssetIntegrity,assertEuAssetProof,compactEuImageProof,htmlIntegrity} from './content-integrity.js';
import {normalizeEuBody,normalizeFinalEuBody} from './eu-normalize.js';

const image=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,1,2]);
const sha=createHash('sha256').update(image).digest('hex');
const embedded='data:image/png;base64,'+image.toString('base64');

test('safe table indentation is optimized alongside protected whitespace, without reserializing attributes',()=>{
  const protectedPart='<pre>one  \n  <div>literal indentation</div>\n</pre>';
  const html=protectedPart+'\n  <table data-value="keep  spacing">\n    <tbody>\n      <tr><td>two  words</td></tr>\n    </tbody>\n  </table>';
  const out=normalizeEuBody(html);
  assert.equal(out.status,'verified');assert(out.body.startsWith(protectedPart));
  assert.match(out.body,/\n<table data-value="keep  spacing">\n<tbody>\n<tr>/);
  assert.match(out.body,/<td>two  words<\/td>/);
  assert.deepEqual(htmlIntegrity(out.body),htmlIntegrity(html));
});
test('inline white-space, stylesheet selectors, fences and attribute values are protected selectively',()=>{
  const parts=[
    '<div style="white-space: pre-wrap">\n  <p>indented</p>\n</div>',
    '<style>.literal { white-space: pre; }</style><div class="literal">\n  <p>indented</p>\n</div>',
    '<div title="attribute\n  <p>literal tag-like text</p>">text</div>',
  ];
  for(const part of parts){
    const html=part+'\n  <div>safe</div>',out=normalizeEuBody(html);
    assert(out.body.startsWith(part),part);assert(out.body.endsWith('\n<div>safe</div>'),part);
    assert.equal(out.status,'verified');
  }
  const inline='<p>first <span>second</span> <em>third</em></p>';
  assert.equal(normalizeEuBody(inline).body,inline);
  const fenced='```html\n  <div>literal</div>\n```\n  <div>safe</div>';
  // The old exact text-node guard also covers the closing fence plus following
  // indentation. If it cannot prove equivalence, leave the complete input.
  assert.equal(normalizeEuBody(fenced).body,fenced);
});
test('final legal normalization preserves significant trailing spaces within preformatted text',()=>{
  const html='<pre>first  \nsecond \t\n</pre>\n  <p>ordinary</p>';
  const out=normalizeFinalEuBody(html);
  assert.match(out,/<pre>first  \nsecond \t\n<\/pre>/);
  assert.match(out,/\n<p>ordinary<\/p>/);
  assert.deepEqual(htmlIntegrity(out),htmlIntegrity(html));
});
test('embedded images become sidecars without changing any Markdown byte',async()=>{
  const html=`# Heading\n\n<p>Article 1 <img alt='equation' src='${embedded}' width="10"></p>`;
  const out=await extractEuAssets(html,'https://official.example/act');
  assert.equal(out.assets.length,1);assert.deepEqual(out.assets[0].bytes,image);
  assert.equal(out.assets[0].name,`images/${sha}.png`);
  assert.equal(out.derivedHtml,html);
  assert.equal(out.occurrences[0].source,embedded);
  assertEuAssetIntegrity(htmlIntegrity(html),out.derivedHtml,out.occurrences,()=>image);
  const proof=compactEuImageProof(out.occurrences);
  assert(!JSON.stringify(proof).includes('base64'));assert(!out.assets[0].sourceUrl.startsWith('data:'));
  assertEuAssetProof(html,out.derivedHtml,proof,()=>image);
  assert.throws(()=>assertEuAssetProof(html,out.derivedHtml,[{...proof[0],sourceSha256:'0'.repeat(64)}],()=>image));
  assert(html.includes(embedded));
});
test('external images are loaded once, share binary content and preserve each original occurrence',async()=>{
  const html=`<p>Article 1</p><img src="image.png" alt="first"><img src="image.png" alt="second"><img src="${embedded}">`;
  const seen:string[]=[];
  const out=await extractEuAssets(html,'https://official.example/path/act',async url=>{
    seen.push(url);return {bytes:image,contentType:'image/png; charset=binary',url};
  });
  assert.deepEqual(seen,['https://official.example/path/image.png']);assert.equal(out.assets.length,1);
  assert.equal(out.occurrences.length,3);assert.deepEqual(out.occurrences.map(o=>o.index),[0,1,2]);
  assertEuAssetIntegrity(htmlIntegrity(html),out.derivedHtml,out.occurrences,()=>image);
});
test('valid unpadded Base64 and percent-encoded binary data preserve exact bytes',async()=>{
  const sources=['data:image/png;base64,'+image.toString('base64').replace(/=+$/,''),
    'data:image/png,'+[...image].map(b=>'%'+b.toString(16).padStart(2,'0')).join('')];
  for(const source of sources){const out=await extractEuAssets(`<img src="${source}">`,'https://official.example/act');assert.deepEqual(out.assets[0].bytes,image);}
});
test('image extraction integrity rejects changed bytes, lost or reordered images and changed legal text',async()=>{
  const html=`<p>Article 1 must not change.</p><img src="${embedded}"><img src="other.png">`;
  const out=await extractEuAssets(html,'https://official.example/act',async()=>({bytes:Buffer.from('second image'),contentType:'image/png'}));
  const read=(name:string)=>out.assets.find(a=>a.name===name)!.bytes;
  assert.throws(()=>assertEuAssetIntegrity(htmlIntegrity(html),out.derivedHtml,out.occurrences,()=>Buffer.from('changed')));
  assert.throws(()=>assertEuAssetIntegrity(htmlIntegrity(html),out.derivedHtml.replace('must not','must'),out.occurrences,read));
  assert.throws(()=>assertEuAssetIntegrity(htmlIntegrity(html),out.derivedHtml.replace(/<img[^>]+>/,''),out.occurrences,read));
  assert.throws(()=>assertEuAssetIntegrity(htmlIntegrity(html),out.derivedHtml,[out.occurrences[0],out.occurrences[0]],read));
  const swapped=out.derivedHtml.replace(embedded,'placeholder').replace('other.png',embedded).replace('placeholder','other.png');
  assert.throws(()=>assertEuAssetIntegrity(htmlIntegrity(html),swapped,out.occurrences,read));
});

test('image index must cover every Markdown occurrence and may not rewrite frozen references',async()=>{
  const html=`<p>Article 1</p><img src="${embedded}"><img src="second.png">`;
  await assert.rejects(()=>extractEuAssets(html,'https://official.example/act'),/loader|unresolved|required/i);
  const out=await extractEuAssets(html,'https://official.example/act',async()=>({bytes:image,contentType:'image/png'}));
  assert.equal(out.derivedHtml,html);
  assert.throws(()=>assertEuAssetIntegrity(htmlIntegrity(html),html,out.occurrences.slice(0,1),()=>image));
  const rewritten=html.replace(embedded,out.occurrences[0].target);
  assert.throws(()=>assertEuAssetProof(html,rewritten,compactEuImageProof(out.occurrences),()=>image),/Markdown|reference|unchanged/i);
});
test('invalid embedded data fails without altering original text and ordinary Base64 text is untouched',async()=>{
  for(const source of ['data:image/png;base64,not_base64','data:image/png;base64,AA=A','data:text/html;base64,SGk=']){
    const html=`<p>Original</p><img src="${source}">`;
    await assert.rejects(()=>extractEuAssets(html,'https://official.example/act'));
    assert(html.includes(source));
  }
  const text='<pre>data:image/png;base64,not_base64</pre>';
  assert.equal((await extractEuAssets(text,'https://official.example/act')).derivedHtml,text);
});
