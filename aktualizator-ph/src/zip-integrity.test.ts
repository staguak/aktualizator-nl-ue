import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,unzipSync} from 'fflate';
import {unpackOfficialZip} from './official-sources.js';
import {crc32} from 'node:zlib';
import {decodeZipPayloads,zipInventory} from './zip-integrity.js';
import {XmlValidationInfrastructureError} from './xml-validation.js';

function fixture(){const bytes=Buffer.from(zipSync({'law.xml':Buffer.from('<law>official bytes</law>')}, {level:0}));
  let central=0;while(bytes.readUInt32LE(central)!==0x02014b50)central++;return {bytes,central};}
test('ZIP CRC validation catches corruption even when decompression succeeds',()=>{
  const {bytes,central}=fixture();bytes[30+bytes.readUInt16LE(26)+bytes.readUInt16LE(28)+5]^=1;
  assert(unzipSync(bytes)['law.xml']);assert.throws(()=>unpackOfficialZip(bytes),/CRC/);
  const wrong=fixture();wrong.bytes.writeUInt32LE(0,wrong.central+16);
  assert.throws(()=>unpackOfficialZip(wrong.bytes),/inconsistent ZIP/);
});
test('ZIP rejects symlinks, inconsistent local names, overlapping entries and directory bounds',()=>{
  for(const scenario of ['symlink','name','offset','directory','flags']){
    const {bytes,central}=fixture();
    if(scenario==='symlink')bytes.writeUInt32LE((0xa1ff*65536)>>>0,central+38);
    if(scenario==='name')bytes[30]^=1;
    if(scenario==='offset')bytes.writeUInt32LE(central,central+42);
    if(scenario==='directory')bytes.writeUInt32LE(0,bytes.length-22+12);
    if(scenario==='flags')bytes.writeUInt16LE(1,central+8);
    assert.throws(()=>unpackOfficialZip(bytes),/ZIP/);
  }
});
test('ZIP supports stored/deflated original bytes and rejects an archive with trailing garbage',()=>{
  for(const level of [0,6] as const){const bytes=Buffer.from(zipSync({'source.xml':Buffer.from('<source/>')},{level}));
    assert.deepEqual(Buffer.from(unpackOfficialZip(bytes)['source.xml']),Buffer.from('<source/>'));
    assert.throws(()=>unpackOfficialZip(Buffer.concat([bytes,Buffer.from('garbage')])) ,/ZIP/);
  }
});
test('ZIP data descriptors are checked against the directory and decoded content',()=>{
  const {bytes,central}=fixture(),descriptor=Buffer.alloc(16);descriptor.writeUInt32LE(0x08074b50);
  bytes.copy(descriptor,4,central+16,central+28);
  const streamed=Buffer.concat([bytes.subarray(0,central),descriptor,bytes.subarray(central)]);
  streamed.writeUInt16LE(8,6);streamed.fill(0,14,26);streamed.writeUInt16LE(8,central+16+8);
  streamed.writeUInt32LE(central+16,streamed.length-22+16);
  assert.equal(Buffer.from(unpackOfficialZip(streamed)['law.xml']).toString(),'<law>official bytes</law>');
  streamed[central+4]^=1;assert.throws(()=>unpackOfficialZip(streamed),/ZIP/);
});
test('ZIP cannot forge a prefix CRC to hide an understated actual DEFLATE output',()=>{
  const prefix=Buffer.from('<toestand bwb-id="BWBR0009616"/>'),full=Buffer.concat([prefix,Buffer.from('hidden suffix '.repeat(10000))]);
  const bytes=Buffer.from(zipSync({'state.xml':full},{level:6})),central=bytes.readUInt32LE(bytes.length-22+16);
  bytes.writeUInt32LE(crc32(prefix),14);bytes.writeUInt32LE(prefix.length,22);
  bytes.writeUInt32LE(crc32(prefix),central+16);bytes.writeUInt32LE(prefix.length,central+24);
  assert.deepEqual(Buffer.from(unzipSync(bytes)['state.xml']),prefix,'The old decoder silently truncates the actual stream.');
  assert.throws(()=>unpackOfficialZip(bytes),/DEFLATE stream or expanded size/);
});
test('ZIP rejects unconsumed compressed bytes even when the decoded CRC and size are correct',()=>{
  const body=Buffer.from('unchanged official bytes'),original=Buffer.from(zipSync({'law.xml':body},{level:6}));
  const old=original.readUInt32LE(original.length-22+16),junk=Buffer.from('hidden compressed suffix');
  const bytes=Buffer.concat([original.subarray(0,old),junk,original.subarray(old)]),central=old+junk.length;
  bytes.writeUInt32LE(original.readUInt32LE(18)+junk.length,18);
  bytes.writeUInt32LE(original.readUInt32LE(old+20)+junk.length,central+20);
  bytes.writeUInt32LE(central,bytes.length-22+16);
  assert.deepEqual(Buffer.from(unzipSync(bytes)['law.xml']),body);
  assert.throws(()=>unpackOfficialZip(bytes),/unconsumed compressed bytes/);
});
test('unexpected ZIP decoder failures remain fatal validation infrastructure errors',()=>{
  const bytes=Buffer.from(zipSync({'law.xml':Buffer.from('<law/>')},{level:6})),inventory=zipInventory(bytes);
  assert.throws(()=>decodeZipPayloads(bytes,inventory,()=>{throw Object.assign(new Error('allocator failed'),{code:'Z_MEM_ERROR'});}),XmlValidationInfrastructureError);
  assert.throws(()=>decodeZipPayloads(bytes,inventory,()=>Buffer.from('unsupported decoder result')),XmlValidationInfrastructureError);
});
