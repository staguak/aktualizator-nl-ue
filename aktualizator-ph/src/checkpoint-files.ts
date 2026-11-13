import fs from 'node:fs';
import {hash} from './release-store.js';

// Completed-act files are immutable within a build. Reuse a verified local
// buffer only while file identity, size and nanosecond change times still match.
// This avoids rereading all earlier ZIPs after each newly completed act.
export class CheckpointFileReader {
  private files=new Map<string,{signature:string;md5:string;bytes:Buffer}>();
  constructor(private read:(name:string)=>Buffer=name=>fs.readFileSync(name)){}
  load(name:string,expectedMd5:string):Buffer {
    if(!/^[a-f0-9]{32}$/.test(expectedMd5))throw new Error('Invalid checkpoint checksum.');
    const stat=fs.lstatSync(name,{bigint:true});
    if(!stat.isFile())throw new Error('Checkpoint must contain regular files only.');
    const signature=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
    const known=this.files.get(name);
    if(known?.signature===signature&&known.md5===expectedMd5)return known.bytes;
    const bytes=this.read(name);
    if(BigInt(bytes.length)!==stat.size||hash(bytes,'md5')!==expectedMd5)throw new Error('Checkpoint file checksum mismatch.');
    this.files.set(name,{signature,md5:expectedMd5,bytes});return bytes;
  }
}
