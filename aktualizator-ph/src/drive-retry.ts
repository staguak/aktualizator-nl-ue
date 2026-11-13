import {operationMetrics} from './operation-metrics.js';
export function driveStatus(error:unknown):number|undefined {
  const e=error as any;const status=e?.response?.status ?? e?.code;
  return typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?status:undefined;
}
function requestTimedOut(error:unknown):boolean {
  const e=error as any;
  // Pinned Gaxios/node-fetch can wrap its own timeout as an AbortError with
  // no code. A generic abort is not retryable: require the SDK deadline signal.
  return e?.code==='TimeoutError'||e instanceof DOMException&&e.name==='TimeoutError'||typeof e?.config?.timeout==='number'&&
    Number.isFinite(e.config.timeout)&&e.config.timeout>0&&e.config.signal?.aborted===true&&
    e.config.signal.reason?.name==='TimeoutError';
}
// Only provider status and allowlisted reason codes may reach diagnostics.
// Gaxios messages, URLs, request bodies and headers can contain credentials.
export function safeDriveFailure(error:unknown):string {
  const e=error as any,status=driveStatus(error);
  const allowed=new Set(['rateLimitExceeded','userRateLimitExceeded','backendError',
    'storageQuotaExceeded','dailyLimitExceeded','insufficientFilePermissions',
    'insufficientPermissions','notFound','authError','invalidCredentials','fileNotDownloadable']);
  const reasons=(e?.response?.data?.error?.errors??[]);
  const codes=Array.isArray(reasons)?[...new Set(reasons.map((r:any)=>r?.reason).filter((r:unknown)=>typeof r==='string'&&allowed.has(r)))]:[];
  const transport=['ECONNRESET','ETIMEDOUT','EPIPE','ECONNABORTED','ENOTFOUND','EAI_AGAIN'].includes(e?.code)?e.code:undefined;
  return `Drive API failure${Number.isInteger(status)?` (HTTP ${status})`:''}${codes.length?` [${codes.join(', ')}]`:''}${transport?` [${transport}]`:''}${requestTimedOut(error)?' [REQUEST_TIMEOUT]':''}.`;
}
export function transientDriveError(error:unknown):boolean {
  const e=error as any,status=driveStatus(error);
  if(status===403){const reasons=e?.response?.data?.error?.errors;return Array.isArray(reasons)&&reasons.some((r:any)=>['rateLimitExceeded','userRateLimitExceeded','backendError'].includes(r?.reason));}
  return status!==undefined?[408,429,500,502,503,504].includes(status):
    requestTimedOut(error)||['ECONNRESET','ETIMEDOUT','EPIPE','ECONNABORTED','ENOTFOUND','EAI_AGAIN'].includes(e?.code);
}
export async function retryDrive<T>(operation:()=>Promise<T>,wait:(ms:number)=>Promise<void> = ms=>new Promise(r=>setTimeout(r,ms))):Promise<T> {
  for(let attempt=0;;attempt++){
    try{return await operation();}
    catch(error){if(attempt>=4||!transientDriveError(error))throw error;
      // Never log Google error objects: they can include OAuth request data.
      operationMetrics.add('driveRetries');console.warn(`Drive transient failure; retry ${attempt+1}/4.`);
      await wait(Math.min(16_000,1000*2**attempt)+Math.floor(Math.random()*250));
    }
  }
}

// Treat SDK-shaped errors conservatively, even when no response was received.
export function safeFailureMessage(error:unknown,fallback='Operation failed.'):string {
  const e=error as any;
  // Native fetch DOMExceptions have legacy numeric .code values (e.g.23),
  // which are not evidence of a Google SDK request or a Drive HTTP response.
  if(error instanceof DOMException)return error.name==='TimeoutError'?'Request failed [REQUEST_TIMEOUT].':
    error.name==='AbortError'?'Request aborted.':fallback;
  if(e&&(e.response||e.request||e.config||e.code!==undefined))return safeDriveFailure(error);
  return error instanceof Error?error.message:fallback;
}
