/** Local read-only collection of one original diagnostic trace. No Drive/API I/O. */
import {collectOperationErrors} from '../src/operation-errors.js';

try{
  const [directory,trace,...extra]=process.argv.slice(2);
  if(!directory||!trace||extra.length)throw new Error();
  const result=collectOperationErrors(directory,trace);
  console.log(JSON.stringify(result,null,2));
  process.exitCode=result.status==='PASS'?0:result.status==='FAIL'?1:2;
}catch{console.error('Unable to verify local operation error evidence.');process.exitCode=2;}
