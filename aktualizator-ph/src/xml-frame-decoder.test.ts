import test from 'node:test';
import assert from 'node:assert/strict';
import {XmlFrameDecoder,XmlFrameLimitError} from './xml-frame-decoder.js';

test('XML frame bounds apply independently across coalesced and fragmented responses',()=>{
  const decoder=new XmlFrameDecoder(10);
  assert.deepEqual(decoder.push('12345678'),[]);
  assert.deepEqual(decoder.push('90\nabcdefghij\nxyz'),['1234567890','abcdefghij']);
  assert.deepEqual(decoder.push('\n'),['xyz']);
});
test('an over-limit XML response is rejected whether its delimiter arrived or is still absent',()=>{
  for(const input of ['12345678901','12345678901\n','ok\n12345678901'])assert.throws(()=>new XmlFrameDecoder(10).push(input),XmlFrameLimitError);
  assert.throws(()=>new XmlFrameDecoder(0),/Invalid/);
});
