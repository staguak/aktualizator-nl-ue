import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {OfficialSources,loadSourceArchive} from './official-sources.js';
import {sourceBlob} from './source-cache.js';

test('public source catalogs use separately verified objects and fail when an object is missing or changed',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-source-files-'));
  process.env.LAW_SOURCE_CACHE_DIR=root;
  process.env.LAW_PUBLIC_SOURCE_FILES='1';
  try{
    const source=new OfficialSources('EU','32025D2591',{from:'2025-01-01',to:'2026-11-19',observedOn:'2026-11-19'});
    const uri='https://publications.europa.eu/resource/celex/32025D2591';
    const payload=Buffer.from('<official>Source fixture</official>');
    source.add('documents/native.xml',{bytes:payload,url:uri,contentType:'application/xml'},uri,'CELLAR-test');
    const catalog=source.build('01_32025D2591.sources.zip');
    assert.match(catalog.metadata.name,/\.sources\.json$/);
    assert.equal(JSON.parse(catalog.bytes.toString()).entries.length,1);
    const result=loadSourceArchive(catalog.bytes,catalog.metadata,'EU','32025D2591');
    assert.deepEqual(result.items['documents/native.xml'],payload);
    const object=sourceBlob(root,result.index.entries[0].sha256);
    fs.writeFileSync(object,Buffer.from('modified'));
    assert.throws(()=>loadSourceArchive(catalog.bytes,catalog.metadata,'EU','32025D2591'),/checksum/);
    fs.unlinkSync(object);
    assert.throws(()=>loadSourceArchive(catalog.bytes,catalog.metadata,'EU','32025D2591'),/ENOENT/);
  }finally{
    delete process.env.LAW_SOURCE_CACHE_DIR;
    delete process.env.LAW_PUBLIC_SOURCE_FILES;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('a rejected public representation must be retried when resuming a checkpoint',async()=>{
  const {validateCheckpointArchive}=await import('./xml-archive-validation.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-source-retry-'));
  const originalValidation=process.env.LAW_XML_VALIDATION;
  process.env.LAW_SOURCE_CACHE_DIR=root;
  process.env.LAW_PUBLIC_SOURCE_FILES='1';
  process.env.LAW_XML_VALIDATION='required';
  try{
    const celex='32025D2591',url='https://publications.europa.eu/resource/celex/'+celex;
    const source=new OfficialSources('EU',celex,{from:'2025-01-01',to:'2026-11-19',observedOn:'2026-11-19'});
    source.add('document.xhtml',{bytes:Buffer.from('<p>Source fixture</p>'),url,contentType:'application/xhtml+xml'},url,'CELLAR-XHTML');
    source.warning('The downloaded Formex did not validate.',{code:'FORMEX_REJECTED',
      classification:'REPRESENTATION_REJECTED',representation:'Formex',documentId:celex});
    const checkpoint=source.build('01_32025D2591.sources.zip');
    await assert.rejects(validateCheckpointArchive(checkpoint.bytes,checkpoint.metadata,'EU',celex),/requires another source attempt/);
  }finally{
    delete process.env.LAW_SOURCE_CACHE_DIR;
    delete process.env.LAW_PUBLIC_SOURCE_FILES;
    if(originalValidation===undefined)delete process.env.LAW_XML_VALIDATION;
    else process.env.LAW_XML_VALIDATION=originalValidation;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
