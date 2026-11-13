export class XmlFrameLimitError extends Error {constructor(){super('XML validator response frame exceeds its limit.');}}

// Limit each NDJSON frame, rather than the transport chunk (which can contain
// the end of one valid frame followed by another valid response).
export class XmlFrameDecoder {
  private buffer='';
  constructor(private readonly limit=1_000_000){if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid XML response frame limit.');}
  push(chunk:string):string[]{
    this.buffer+=chunk;const frames:string[]=[];
    for(;;){
      const end=this.buffer.indexOf('\n');if(end<0)break;
      if(end>this.limit)throw new XmlFrameLimitError();
      frames.push(this.buffer.slice(0,end));this.buffer=this.buffer.slice(end+1);
    }
    if(this.buffer.length>this.limit)throw new XmlFrameLimitError();
    return frames;
  }
}
