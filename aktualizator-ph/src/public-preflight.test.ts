import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fetchSourceFile,sourceBlob} from './source-cache.js';
import {verifyUnchangedSources} from './public-preflight.js';

test('preflight requires a verified prior blob and handles 304, changed response and remote failure',async()=>{
  const cache=fs.mkdtempSync(path.join(os.tmpdir(),'public-preflight-'));
  const url='https://publications.europa.eu/webapi/rdf/sparql?query=fixture';
  const headers={Accept:'application/sparql-results+json'};
  try{
    const body=await fetchSourceFile(url,headers,{cacheDir:cache,fetcher:async()=>new Response('official fixture',{
      headers:{ETag:'"verified"', 'Content-Type':'application/sparql-results+json'}
    })});
    const request={requestedUrl:url,kind:'CELLAR-SPARQL',sha256:body.sha256!,verificationRequest:{headers}};
    const unchanged=await verifyUnchangedSources([request,request],cache,async(_url,options)=>{
      assert.equal(new Headers(options?.headers).get('if-none-match'),'"verified"');
      return new Response(null,{status:304});
    });
    assert.deepEqual(unchanged,{status:'NO_CHANGE',checked:1});
    assert.equal((await verifyUnchangedSources([request],cache,async()=>new Response('new content'))).status,'CHANGED');
    assert.equal((await verifyUnchangedSources([request],cache,async()=>new Response(null,{status:503}))).status,'UNKNOWN');
    fs.writeFileSync(sourceBlob(cache,body.sha256!),Buffer.from('changed'));
    let contacted=false;
    assert.equal((await verifyUnchangedSources([request],cache,async()=>{contacted=true;return new Response(null,{status:304});})).status,'UNKNOWN');
    assert.equal(contacted,false);
  }finally{fs.rmSync(cache,{recursive:true,force:true});}
});

test('BWB verification retains its official request headers without admitting arbitrary headers',async()=>{
  const cache=fs.mkdtempSync(path.join(os.tmpdir(),'public-preflight-bwb-'));
  const url='https://zoekservice.overheid.nl/sru/Search?version=2.0';
  const headers={Accept:'application/xml','User-Agent':'NL-Law-Updater/1.0','Cache-Control':'no-cache',Pragma:'no-cache'};
  try{
    const body=await fetchSourceFile(url,headers,{cacheDir:cache,fetcher:async()=>new Response('<response/>',{
      headers:{ETag:'"bwb-verified"','Content-Type':'application/xml'}
    })});
    assert.deepEqual(body.cacheHint?.headers,headers);
    const request={requestedUrl:url,kind:'SRU-2.0',sha256:body.sha256!,verificationRequest:{headers}};
    const unchanged=await verifyUnchangedSources([request],cache,async(_url,options)=>{
      const retained=new Headers(options?.headers);
      for(const [name,value] of Object.entries(headers))assert.equal(retained.get(name),value);
      assert.equal(retained.get('if-none-match'),'"bwb-verified"');
      return new Response(null,{status:304});
    });
    assert.deepEqual(unchanged,{status:'NO_CHANGE',checked:1});
    for(const invalid of [
      {...request,requestedUrl:'https://publications.europa.eu/webapi/rdf/sparql'},
      {...request,verificationRequest:{headers:{...headers,Authorization:'unapproved'}}}
    ])await assert.rejects(verifyUnchangedSources([invalid],cache),/Unverifiable prior source request/);
  }finally{fs.rmSync(cache,{recursive:true,force:true});}
});

test('an official SRU catalog can prove unchanged bytes without an HTTP validator',async()=>{
  const cache=fs.mkdtempSync(path.join(os.tmpdir(),'public-preflight-sru-'));
  const body='<searchRetrieveResponse/>';
  const headers={Accept:'application/xml','User-Agent':'NL-Law-Updater/1.0'};
  const request={requestedUrl:'https://zoekservice.overheid.nl/sru/Search?version=2.0&operation=searchRetrieve&x-connection=BWB',
    kind:'SRU-2.0',sha256:createHash('sha256').update(body).digest('hex'),verificationRequest:{headers}};
  try{
    const matched=await verifyUnchangedSources([request],cache,async()=>new Response(body));
    assert.deepEqual(matched,{status:'NO_CHANGE',checked:1});
    assert.equal((await verifyUnchangedSources([request],cache,async()=>new Response('<different/>'))).status,'CHANGED');
    assert.equal((await verifyUnchangedSources([request],cache,async()=>new Response(null,{status:503}))).status,'UNKNOWN');
    let contacted=false;
    const anotherEndpoint={...request,requestedUrl:'https://zoekservice.overheid.nl/other'};
    const rejected=await verifyUnchangedSources([anotherEndpoint],cache,async()=>{contacted=true;return new Response(body);});
    assert.equal(rejected.status,'UNKNOWN');
    assert.equal(contacted,false);
  }finally{fs.rmSync(cache,{recursive:true,force:true});}
});
