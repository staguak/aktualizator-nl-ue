import {rememberConcurrentFailures} from './operation-errors.js';

// Stop taking new work on failure, but drain every in-flight operation before
// returning. Callers can safely put manifests and cleanup after this barrier.
export async function runPool<T>(items: readonly T[], limit: number, work: (item:T,index:number)=>Promise<void>):Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit.');
  let next=0, failed=false, failure:unknown;const failures:unknown[]=[];
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(!failed && next<items.length){
      const index=next++;
      try { await work(items[index],index); }
      catch(error){failures.push(error);if(!failed){failed=true;failure=error;}}
    }
  }));
  if(failed){rememberConcurrentFailures(failures);throw failure;}
}

export function shareInFlight<T>(loader:(key:string)=>Promise<T>):(key:string)=>Promise<T> {
  const requests=new Map<string,Promise<T>>();
  return key=>{
    let request=requests.get(key);
    if(!request){request=loader(key);requests.set(key,request);void request.catch(()=>{if(requests.get(key)===request)requests.delete(key);});}
    return request;
  };
}
