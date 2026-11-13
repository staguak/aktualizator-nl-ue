export class XmlQueueCapacityError extends Error {constructor(){super('XML validation queue capacity exceeded.');}}

// The Python protocol serves one frame at a time. Do not start the next
// request's service deadline while it is still waiting behind another frame.
export class XmlValidationQueue {
  private pending=0;
  private tail:Promise<void>=Promise.resolve();
  constructor(private readonly limit=8){if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid XML queue limit.');}
  run<T>(operation:()=>Promise<T>):Promise<T>{
    if(this.pending>=this.limit)return Promise.reject(new XmlQueueCapacityError());
    this.pending++;
    const result=this.tail.then(operation);
    this.tail=result.then(()=>undefined,()=>undefined);
    return result.finally(()=>{this.pending--;});
  }
}
