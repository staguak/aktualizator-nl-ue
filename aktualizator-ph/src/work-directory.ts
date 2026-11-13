import fs from 'node:fs';

// Check before recursive cleanup or writes. existsSync would overlook a
// dangling symlink; lstat distinguishes the path itself from its target.
export function assertWorkDirectory(directory:string):void{
  try{if(!fs.lstatSync(directory).isDirectory())throw new Error('Work directory must be a real directory, not a symlink or file.');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
