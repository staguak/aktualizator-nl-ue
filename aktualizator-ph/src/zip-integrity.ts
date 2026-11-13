import {crc32,inflateRawSync} from 'node:zlib';
import {XmlValidationInfrastructureError} from './xml-validation.js';

// A decoder using the declared output size can silently truncate a lying ZIP.
// Inspect the bounded central directory before inflation and bind it to each
// local header. ZIP64/multi-volume/encrypted archives fail closed explicitly.
export function zipInventory(raw:Uint8Array):Map<string,{crc:number;size:number;method:number;dataOffset:number;compressed:number}>{
  const bytes=Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength),entries=new Map<string,{crc:number;size:number;method:number;dataOffset:number;compressed:number}>();
  const reject=()=>new Error('Invalid, unsupported or inconsistent ZIP directory.');
  if(bytes.length<22)throw reject();
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)
    if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
  if(end<0)throw reject();
  const count=bytes.readUInt16LE(end+10),directorySize=bytes.readUInt32LE(end+12),directory=bytes.readUInt32LE(end+16);
  if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==count||
    count===65535||directorySize===0xffffffff||directory===0xffffffff||directory+directorySize!==end)throw reject();
  let cursor=directory;const ranges:[number,number][]=[];
  for(let i=0;i<count;i++){
    if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)throw reject();
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),
      compressed=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24),nameSize=bytes.readUInt16LE(cursor+28),
      extraSize=bytes.readUInt16LE(cursor+30),commentSize=bytes.readUInt16LE(cursor+32),offset=bytes.readUInt32LE(cursor+42),
      mode=bytes.readUInt32LE(cursor+38)>>>16,type=mode&0xf000;
    if(cursor+46+nameSize+extraSize+commentSize>end||bytes.readUInt16LE(cursor+34)||
      flags&~0x080e||flags&1||![0,8].includes(method)||compressed===0xffffffff||size===0xffffffff||
      offset+30>directory||bytes.readUInt32LE(offset)!==0x04034b50||type!==0&&type!==0x8000)
      throw new Error('Unsafe ZIP type, encryption, compression or entry bounds.');
    const nameBytes=bytes.subarray(cursor+46,cursor+46+nameSize),name=new TextDecoder('utf-8',{fatal:true}).decode(nameBytes);
    if(entries.has(name))throw new Error('Duplicate official ZIP member.');
    if(bytes.readUInt16LE(offset+6)!==flags||bytes.readUInt16LE(offset+8)!==method||bytes.readUInt16LE(offset+26)!==nameSize)
      throw reject();
    const data=offset+30+nameSize+bytes.readUInt16LE(offset+28);let finish=data+compressed;
    if(finish>directory||!bytes.subarray(offset+30,offset+30+nameSize).equals(nameBytes))throw reject();
    if(!(flags&8)&&(bytes.readUInt32LE(offset+14)!==crc||bytes.readUInt32LE(offset+18)!==compressed||bytes.readUInt32LE(offset+22)!==size))throw reject();
    if(flags&8){
      if(finish+12>directory)throw reject();
      const descriptor=[finish,...bytes.readUInt32LE(finish)===0x08074b50?[finish+4]:[]].find(at=>
        at+12<=directory&&bytes.readUInt32LE(at)===crc&&bytes.readUInt32LE(at+4)===compressed&&bytes.readUInt32LE(at+8)===size);
      if(descriptor===undefined)throw reject();
      finish=descriptor+12;
    }
    ranges.push([offset,finish]);entries.set(name,{crc,size,method,dataOffset:data,compressed});cursor+=46+nameSize+extraSize+commentSize;
  }
  if(cursor!==end)throw reject();
  ranges.sort(([a],[b])=>a-b);
  if(ranges.some(([start],i)=>i>0&&start<ranges[i-1][1]))throw reject();
  return entries;
}
export function decodeZipPayloads(raw:Uint8Array,inventory:ReturnType<typeof zipInventory>,inflate:typeof inflateRawSync=inflateRawSync):Record<string,Uint8Array>{
  const bytes=Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength),items:Record<string,Uint8Array>=Object.create(null);
  for(const [name,entry] of inventory){
    const payload=bytes.subarray(entry.dataOffset,entry.dataOffset+entry.compressed);
    if(entry.method===0){
      if(entry.compressed!==entry.size)throw new Error('ZIP stored size mismatch.');
      items[name]=Buffer.from(payload);continue;
    }
    let result:{buffer:Buffer;engine:{bytesWritten:number}};
    try{
      // Node supports info:true; @types/node currently types only Buffer.
      result=inflate(payload,{maxOutputLength:Math.max(1,entry.size),info:true}) as unknown as typeof result;
    }catch(error){
      if(['ERR_BUFFER_TOO_LARGE','Z_DATA_ERROR','Z_BUF_ERROR','Z_NEED_DICT'].includes((error as NodeJS.ErrnoException).code??''))
        throw new Error('Invalid ZIP DEFLATE stream or expanded size.');
      throw new XmlValidationInfrastructureError('ZIP validation infrastructure failed; processing stopped.');
    }
    if(!Buffer.isBuffer(result?.buffer)||!Number.isSafeInteger(result?.engine?.bytesWritten))
      throw new XmlValidationInfrastructureError('ZIP decoder did not provide bounded stream evidence.');
    if(result.engine.bytesWritten!==entry.compressed)throw new Error('ZIP DEFLATE stream has unconsumed compressed bytes.');
    items[name]=result.buffer;
  }
  assertZipPayloads(items,inventory);return items;
}
export function assertZipPayloads(items:Record<string,Uint8Array>,inventory:ReturnType<typeof zipInventory>):void{
  if(Object.keys(items).length!==inventory.size)throw new Error('ZIP inventory mismatch.');
  for(const [name,value] of Object.entries(items)){
    const expected=inventory.get(name);
    if(!expected||value.length!==expected.size||crc32(value)!==expected.crc)throw new Error('ZIP member CRC/size mismatch.');
  }
}
