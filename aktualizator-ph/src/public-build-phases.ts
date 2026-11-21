type Phase = 'BASE' | 'UPDATE';

export async function runPublicBuildPhases<T>(initialize:boolean, rangeFrom:string, rangeTo:string,
  build:(phase:Phase,to:string)=>Promise<T>):Promise<{base?:T;update:T}>{
  if(!initialize)return {update:await build('UPDATE',rangeTo)};
  if(rangeTo<=rangeFrom)throw new Error('Public initialization requires a target date later than the baseline.');
  const base=await build('BASE',rangeFrom);
  return {base,update:await build('UPDATE',rangeTo)};
}
