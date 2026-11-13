import {createHash} from 'node:crypto';

export interface StoredObject {id:string; size:number; md5:string; sha256:string}
export interface ReleaseStore {
  read(key:string):Promise<Buffer|null>;
  stat(key:string):Promise<StoredObject|null>;
  write(key:string,bytes:Buffer,immutable:boolean):Promise<StoredObject>;
  list(prefix:string):Promise<string[]>;
  remove(key:string):Promise<void>;
  /** Disposable evidence: remove only the exact, still-matching object ID. */
  removeIfUnchanged?(key:string,expected:StoredObject):Promise<void>;
  removeEmptyDirectory?(prefix:string):Promise<void>;
  directoryUrl?(prefix:string):Promise<string>;
}
export function hash(bytes:Uint8Array,algorithm='sha256'):string {
  return createHash(algorithm).update(bytes).digest('hex');
}
export function safeKey(key:string):void {
  if(!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(key)||key.split('/').some(p=>p==='.'||p==='..'))
    throw new Error('Unsafe storage key.');
}
export function encode(value:unknown):Buffer {return Buffer.from(JSON.stringify(value,null,2)+'\n');}
export async function readJson(store:ReleaseStore,key:string):Promise<unknown|null> {
  const bytes=await store.read(key);return bytes===null?null:JSON.parse(bytes.toString('utf8'));
}
export async function writeJson(store:ReleaseStore,key:string,value:unknown,immutable=false):Promise<StoredObject> {
  return store.write(key,encode(value),immutable);
}
