import fs from 'node:fs';
import path from 'node:path';

// Missing directories may be created, but no existing ancestor may redirect
// cache reads/writes through a symlink. An unusable optional cache is skipped.
export function safeCacheDirectory(directory:string):boolean{
  for(let current=path.resolve(directory);;current=path.dirname(current)){
    try{if(!fs.lstatSync(current).isDirectory())return false;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return false;}
    if(current===path.dirname(current))return true;
  }
}
