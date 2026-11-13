import {Readable} from 'node:stream';
import {operationMetrics} from './operation-metrics.js';
import type {drive_v3} from 'googleapis';
import {hash,safeKey} from './release-store.js';
import {retryDrive,safeDriveFailure} from './drive-retry.js';
import type {ReleaseStore,StoredObject} from './release-store.js';

const FOLDER='application/vnd.google-apps.folder';
const OWNER='nl-eu-public-updater-releases-v1';
// This distribution carries no private installation identifiers.
const PRESERVED_ROOTS=new Set<string>();
const REQUEST={retry:false,timeout:60_000};
const UPLOAD_REQUEST={retry:false,timeout:120_000};
const FIELDS='id,name,mimeType,size,md5Checksum,sha256Checksum,parents,appProperties,trashed,createdTime';
const quote=(s:string)=>s.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
export class MissingReleaseNamespace extends Error {
  constructor(){super('Release namespace missing; explicit initialization required.');this.name='MissingReleaseNamespace';}
}
export class DriveReleaseStore implements ReleaseStore {
  private static reservations=new WeakMap<drive_v3.Drive,{ids:string[];pending?:Promise<void>;used:Set<string>}>();
  private folders=new Map<string,string>();
  private immutableWrites=new Map<string,StoredObject>();
  private constructor(private drive:drive_v3.Drive,private rootId:string,readonly namespace:string){this.folders.set('',rootId);}
  static async cleanupOldTestNamespaces(drive:drive_v3.Drive,protectedNamespace:string,now=new Date(),approvedRootIds:readonly string[]=[]):Promise<string[]>{
    if(!/^release-test-(?:corpus-)?\d+-\d+$/.test(protectedNamespace))throw new Error('Test cleanup requires a workflow-specific protected namespace.');
    const roots=await DriveReleaseStore.query(drive,`trashed = false and mimeType = '${FOLDER}' and appProperties has {key='releaseOwner' and value='${OWNER}'} and appProperties has {key='role' and value='root'}`);
    const deleted:string[]=[];
    for(const root of roots){
      const ns=root.appProperties?.namespace;
      if(!root.id||!approvedRootIds.includes(root.id)||PRESERVED_ROOTS.has(root.id)||
        root.appProperties?.releaseOwner!==OWNER||root.appProperties.role!=='root'||!ns||
        !/^release-test-(?:corpus-)?\d+-\d+$/.test(ns)||ns===protectedNamespace||!root.createdTime||
        !Number.isFinite(Date.parse(root.createdTime))||now.getTime()-Date.parse(root.createdTime)<14*24*3600*1000)continue;
      const ownedTree=async(parent:string):Promise<boolean>=>{
        for(const child of await DriveReleaseStore.query(drive,`trashed = false and '${quote(parent)}' in parents`)){
          if(child.appProperties?.releaseOwner!==OWNER||child.appProperties.namespace!==ns)return false;
          if(child.mimeType===FOLDER&&!await ownedTree(child.id!))return false;
        }
        return true;
      };
      if(!await ownedTree(root.id))continue; // Never trash a tree containing a foreign file.
      await drive.files.update({fileId:root.id,requestBody:{trashed:true},fields:'id,trashed'},REQUEST);
      deleted.push(ns);
    }
    return deleted;
  }
  static async open(drive:drive_v3.Drive,namespace:string,create=false):Promise<DriveReleaseStore>{
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(namespace))throw new Error('Invalid release namespace.');
    const roots=await DriveReleaseStore.query(drive,
      `trashed = false and mimeType = '${FOLDER}' and appProperties has {key='releaseOwner' and value='${OWNER}'} and appProperties has {key='namespace' and value='${namespace}'} and appProperties has {key='role' and value='root'}`);
    if(roots.length>1)throw new Error('Duplicate release roots.');
    let root=roots[0];
    let reservedId:string|undefined;
    if(!root){
      if(!create)throw new MissingReleaseNamespace();
      const id=await DriveReleaseStore.allocate(drive);
      reservedId=id;
      root=await DriveReleaseStore.createDirectory(drive,{id,name:`Aktualizator-${namespace}`,mimeType:FOLDER,
        appProperties:{releaseOwner:OWNER,namespace,role:'root'}});
    }
    if(!root.id||root.trashed||root.mimeType!==FOLDER||
      reservedId&&(root.id!==reservedId||root.name!==`Aktualizator-${namespace}`)||
      root.appProperties?.releaseOwner!==OWNER||root.appProperties.namespace!==namespace||root.appProperties.role!=='root')
      throw new Error('Unmanaged release root.');
    return new DriveReleaseStore(drive,root.id,namespace);
  }
  private static async createDirectory(drive:drive_v3.Drive,requestBody:drive_v3.Schema$File):Promise<drive_v3.Schema$File>{
    // The reservation survives every retry. A timed-out create may have
    // succeeded; inspect that exact ID before sending another create.
    return retryDrive(async()=>{
      try{return (await drive.files.create({requestBody,fields:FIELDS},REQUEST)).data;}
      catch(error){
        try{return (await retryDrive(()=>drive.files.get({fileId:requestBody.id!,fields:FIELDS},REQUEST))).data;}
        catch{throw error;}
      }
    });
  }
  private static async allocate(drive:drive_v3.Drive):Promise<string>{
    let pool=this.reservations.get(drive);
    if(!pool){pool={ids:[],used:new Set()};this.reservations.set(drive,pool);}
    while(!pool.ids.length){
      if(!pool.pending){const current=pool;
        current.pending=retryDrive(()=>drive.files.generateIds({count:100,space:'drive',type:'files'},REQUEST)).then(result=>{
          const ids=result.data.ids;
          if(!ids?.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id||current.used.has(id)))
            throw new Error('Invalid reserved Drive file IDs.');
          ids.forEach(id=>current.used.add(id));current.ids.push(...ids);
        }).finally(()=>{current.pending=undefined;});
      }
      await pool.pending;
    }
    return pool.ids.pop()!;
  }
  private static async query(drive:drive_v3.Drive,q:string):Promise<drive_v3.Schema$File[]>{
    const files:drive_v3.Schema$File[]=[],seen=new Set<string>();let pageToken:string|undefined;
    do{
      if(pageToken){if(seen.has(pageToken))throw new Error('Drive pagination loop.');seen.add(pageToken);}
      const res=await retryDrive(()=>drive.files.list({q,pageSize:1000,pageToken,fields:`nextPageToken,files(${FIELDS})`},REQUEST));
      files.push(...res.data.files??[]);pageToken=res.data.nextPageToken??undefined;
    }while(pageToken);return files;
  }
  private managed(file:drive_v3.Schema$File):void {
    if(!file.id||file.trashed||file.appProperties?.releaseOwner!==OWNER||file.appProperties.namespace!==this.namespace)
      throw new Error('Unmanaged/colliding Drive object.');
  }
  private async children(parent:string):Promise<drive_v3.Schema$File[]>{
    return DriveReleaseStore.query(this.drive,`trashed = false and '${quote(parent)}' in parents`);
  }
  private async folder(key:string,create=false):Promise<string|null>{
    if(this.folders.has(key))return this.folders.get(key)!;
    if(key)safeKey(key);
    const slash=key.lastIndexOf('/'),parentKey=slash<0?'':key.slice(0,slash),name=key.slice(slash+1);
    const parent=await this.folder(parentKey,create);if(!parent)return null;
    const found=(await this.children(parent)).filter(f=>f.name===name);
    if(found.length>1)throw new Error('Duplicate Drive folder.');
    let f=found[0];
    let reservedId:string|undefined;
    if(!f){
      if(!create)return null;
      const id=await DriveReleaseStore.allocate(this.drive);
      reservedId=id;
      f=await DriveReleaseStore.createDirectory(this.drive,{id,name,mimeType:FOLDER,parents:[parent],
        appProperties:{releaseOwner:OWNER,namespace:this.namespace}});
    }
    this.managed(f);if(f.mimeType!==FOLDER||f.name!==name||reservedId&&f.id!==reservedId||!f.parents?.includes(parent))throw new Error('Invalid Drive folder.');
    this.folders.set(key,f.id!);return f.id!;
  }
  private async find(key:string):Promise<drive_v3.Schema$File|null>{
    safeKey(key);const slash=key.lastIndexOf('/'),parentKey=slash<0?'':key.slice(0,slash),name=key.slice(slash+1);
    const parent=await this.folder(parentKey);if(!parent)return null;
    const files=await DriveReleaseStore.query(this.drive,
      `trashed = false and '${quote(parent)}' in parents and name = '${quote(name)}'`);
    if(files.length>1)throw new Error('Duplicate Drive file.');
    const file=files[0];if(!file)return null;this.managed(file);
    if(file.mimeType===FOLDER)throw new Error('Expected binary file, found folder.');
    if(file.name!==name||!file.parents?.includes(parent))throw new Error('Drive lookup location/identity mismatch.');return file;
  }
  private async metadata(file:drive_v3.Schema$File):Promise<StoredObject>{
    this.managed(file);
    // SHA-256 is supplied by Drive for binary files. If absent, compute it over downloaded bytes.
    let sha256=file.sha256Checksum,md5=file.md5Checksum;
    if(!sha256||!md5){const bytes=await this.download(file.id!);sha256=hash(bytes);md5=hash(bytes,'md5');}
    const size=Number(file.size);
    if(!Number.isSafeInteger(size)||size<0)throw new Error('Invalid Drive size.');
    return {id:file.id!,size,md5,sha256};
  }
  private async download(id:string):Promise<Buffer>{
    const res=await retryDrive(()=>this.drive.files.get({fileId:id,alt:'media'},{responseType:'arraybuffer',...REQUEST}));
    return Buffer.from(res.data as unknown as ArrayBuffer);
  }
  async read(key:string):Promise<Buffer|null>{const f=await this.find(key);return f?this.download(f.id!):null;}
  async directoryUrl(prefix:string):Promise<string>{
    if(!prefix.endsWith('/'))throw new Error('Directory URL requires a prefix.');
    const id=await this.folder(prefix.slice(0,-1));
    if(!id)throw new Error('Directory unavailable.');
    return `https://drive.google.com/drive/folders/${id}`;
  }
  async stat(key:string):Promise<StoredObject|null>{const f=await this.find(key);return f?this.metadata(f):null;}
  async write(key:string,bytes:Buffer,immutable:boolean):Promise<StoredObject>{
    safeKey(key);const expected={sha256:hash(bytes),md5:hash(bytes,'md5'),size:bytes.length};
    const known=this.immutableWrites.get(key);
    const metricsKey=`${this.namespace}/${this.rootId}/${key}`;
    const reused=(meta:StoredObject)=>{if(operationMetrics.once('driveReusedFiles',metricsKey))operationMetrics.add('driveReusedBytes',bytes.length);return meta;};
    if(immutable&&known&&known.sha256===expected.sha256&&known.md5===expected.md5&&known.size===expected.size)return reused(known);
    const old=await this.find(key);
    if(old){
      const meta=await this.metadata(old);
      if(meta.sha256===expected.sha256&&meta.md5===expected.md5&&meta.size===expected.size){if(immutable)this.immutableWrites.set(key,meta);return reused(meta);}
      if(immutable)throw new Error('Immutable Drive object overwrite refused.');
    }
    const slash=key.lastIndexOf('/'),parent=await this.folder(slash<0?'':key.slice(0,slash),true);
    const name=key.slice(slash+1),id=old?.id??await DriveReleaseStore.allocate(this.drive);
    const assertWriteIdentity=(file:drive_v3.Schema$File)=>{
      this.managed(file);
      if(file.id!==id||file.name!==name||file.mimeType===FOLDER||!file.parents?.includes(parent!))
        throw new Error('Drive write location/identity mismatch.');
    };
    const f=await retryDrive(async()=>{
      // A retry cannot reuse the consumed upload stream. Keep the reserved ID
      // stable and reconcile a possibly completed write before retrying.
      const media={mimeType:'application/octet-stream',body:Readable.from(bytes)};
      operationMetrics.add('driveUploadAttempts');operationMetrics.add('driveSubmittedBytes',bytes.length);
      try{
        return old?(await this.drive.files.update({fileId:id,media,fields:FIELDS},UPLOAD_REQUEST)).data:
          (await this.drive.files.create({requestBody:{id,name,parents:[parent!],
            appProperties:{releaseOwner:OWNER,namespace:this.namespace}},media,fields:FIELDS},UPLOAD_REQUEST)).data;
      }catch(error){
        let actual:drive_v3.Schema$File;
        try{actual=(await retryDrive(()=>this.drive.files.get({fileId:id,fields:FIELDS},REQUEST))).data;}catch{throw error;}
        assertWriteIdentity(actual);
        const meta=await this.metadata(actual);
        if(meta.sha256!==expected.sha256||meta.md5!==expected.md5||meta.size!==expected.size)throw error;
        return actual;
      }
    }).catch(error=>{
      const e=error as any;
      if(e?.response||e?.request||e?.config||e?.code!==undefined)throw new Error(`Drive write ${key}: ${safeDriveFailure(error)}`);
      throw error;
    });
    assertWriteIdentity(f);const meta=await this.metadata(f);
    if(meta.size!==expected.size||meta.md5!==expected.md5||meta.sha256!==expected.sha256)throw new Error('Drive write checksum mismatch.');
    operationMetrics.once('driveUploadedFiles',metricsKey);
    if(immutable)this.immutableWrites.set(key,meta);
    return meta;
  }
  async list(prefix:string):Promise<string[]>{
    if(prefix!==''&&!prefix.endsWith('/'))throw new Error('Storage list requires directory prefix.');
    const key=prefix.slice(0,-1),folder=await this.folder(key);if(!folder)return [];
    const keys:string[]=[];
    const walk=async(parent:string,p:string):Promise<void>=>{
      const children=await this.children(parent),seen=new Set<string>();
      for(const f of children){
        this.managed(f);if(!f.name)throw new Error('Unnamed Drive object.');safeKey(f.name);
        if(f.name.includes('/')||seen.has(f.name))throw new Error('Colliding Drive object.');seen.add(f.name);
        if(f.mimeType===FOLDER)await walk(f.id!,p+f.name+'/');else keys.push(p+f.name);
      }
    };
    await walk(folder,prefix);return keys.sort();
  }
  async remove(key:string):Promise<void>{
    if(!key.startsWith('releases/')&&!key.startsWith('work/')&&!/^checks\/(runs|retention|commits|resumes|sources)\//.test(key)||key==='checks/resumes/.ready.json')throw new Error('Deletion outside managed retention areas refused.');
    const f=await this.find(key);if(f)await retryDrive(()=>this.drive.files.update({fileId:f.id!,requestBody:{trashed:true},fields:'id,trashed'},REQUEST));
    this.immutableWrites.delete(key);
  }
  async removeIfUnchanged(key:string,expected:StoredObject):Promise<void>{
    safeKey(key);
    if(!this.namespace.startsWith('evidence-')||PRESERVED_ROOTS.has(this.rootId)||
      !/^work\/evidence\/[1-9]\d*-[1-9]\d*\//.test(key))throw new Error('Guarded evidence removal outside disposable areas refused.');
    const slash=key.lastIndexOf('/'),parent=await this.folder(key.slice(0,slash)),name=key.slice(slash+1);
    if(!parent)throw new Error('Evidence retirement parent disappeared.');
    await retryDrive(async()=>{
      // Never resolve by name again: a replacement must not inherit approval.
      // Repeat this check on retries, including reconciliation of a lost response.
      const f=(await this.drive.files.get({fileId:expected.id,
        fields:FIELDS+',ownedByMe,capabilities(canTrash)'},REQUEST)).data;
      if(f.id!==expected.id||f.name!==name||f.mimeType===FOLDER||!f.parents?.includes(parent)||
        f.appProperties?.releaseOwner!==OWNER||f.appProperties.namespace!==this.namespace||
        f.ownedByMe!==true||(f.trashed!==true&&f.capabilities?.canTrash!==true)||Number(f.size)!==expected.size||
        f.md5Checksum!==expected.md5||f.sha256Checksum!==expected.sha256)
        throw new Error('Evidence retirement identity, ownership or bytes changed.');
      if(f.trashed===true)return;
      const result=(await this.drive.files.update({fileId:expected.id,requestBody:{trashed:true},fields:'id,trashed'},REQUEST)).data;
      if(result.id!==expected.id||result.trashed!==true)throw new Error('Evidence retirement was not confirmed.');
    });
    this.immutableWrites.delete(key);
  }
  /** Read-only ownership gate used only for explicit disposable-evidence cleanup.
   * App properties establish the namespace, not actual Google account ownership. */
  async assertEvidenceRetirementOwnership(prefixes:readonly string[]):Promise<void>{
    if(!this.namespace.startsWith('evidence-')||PRESERVED_ROOTS.has(this.rootId)||
      prefixes.some(p=>!/^work\/evidence\/[1-9]\d*-[1-9]\d*\/$/.test(p)))
      throw new Error('Evidence ownership inspection outside disposable areas refused.');
    const owned=async(id:string)=>{
      const f=(await retryDrive(()=>this.drive.files.get({fileId:id,
        fields:FIELDS+',ownedByMe,capabilities(canTrash)'},REQUEST))).data;
      this.managed(f);
      if(f.id!==id||f.ownedByMe!==true||f.capabilities?.canTrash!==true)
        throw new Error('Evidence cleanup requires verified account ownership and trash capability.');
      return f;
    };
    const root=await owned(this.rootId);
    if(root.mimeType!==FOLDER||root.appProperties?.role!=='root')throw new Error('Invalid evidence root.');
    const seen=new Set<string>();
    const walk=async(id:string,parent?:string)=>{
      if(seen.has(id))throw new Error('Repeated evidence ownership traversal.');seen.add(id);
      const f=await owned(id);
      if(parent&&!f.parents?.includes(parent))throw new Error('Evidence ownership parent changed.');
      if(f.mimeType===FOLDER)for(const child of await this.children(id)){
        this.managed(child);if(!child.parents?.includes(id))throw new Error('Evidence ownership parent changed.');
        await walk(child.id!,id);
      }
    };
    for(const prefix of prefixes){const id=await this.folder(prefix.slice(0,-1));if(id)await walk(id);}
  }
  async removeEmptyDirectory(prefix:string):Promise<void>{
    if(!prefix.endsWith('/')||!prefix.startsWith('releases/')&&!prefix.startsWith('work/'))throw new Error('Protected directory cleanup refused.');
    const key=prefix.slice(0,-1);safeKey(key);
    const id=await this.folder(key);if(!id)return;
    const prune=async(parent:string,p:string):Promise<boolean>=>{
      for(const child of await this.children(parent)){
        this.managed(child);
        if(child.mimeType!==FOLDER)return false;
        if(!child.name||!await prune(child.id!,p+'/'+child.name))return false;
      }
      // Re-read immediately before trashing; no files may be present.
      if((await this.children(parent)).length)return false;
      if(this.namespace.startsWith('evidence-')){
        const f=(await retryDrive(()=>this.drive.files.get({fileId:parent,
          fields:FIELDS+',ownedByMe,capabilities(canTrash)'},REQUEST))).data;
        this.managed(f);
        if(f.id!==parent||f.mimeType!==FOLDER||f.ownedByMe!==true||f.capabilities?.canTrash!==true)
          throw new Error('Evidence directory ownership changed.');
        if((await this.children(parent)).length)return false;
      }
      await retryDrive(()=>this.drive.files.update({fileId:parent,requestBody:{trashed:true},fields:'id,trashed'},REQUEST));
      this.folders.delete(p);return true;
    };
    await prune(id,key);
  }
}
