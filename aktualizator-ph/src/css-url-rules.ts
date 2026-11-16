/** Linear-time lexer for CSS url(...) tokens, preserving the historical
 * permissive HTML/CSS extraction rule. No CSS bytes are rewritten here.
 */
export interface CssUrlMatch {
  start:number;
  end:number;
  text:string;
  source:string;
}
export function* cssUrlMatches(css:string):Generator<CssUrlMatch>{
  const length=css.length;
  const nonWhite=new Int32Array(length+1);
  const doubleQuote=new Int32Array(length+1);
  const singleQuote=new Int32Array(length+1);
  const tokenEnd=new Int32Array(length+1);
  nonWhite[length]=doubleQuote[length]=singleQuote[length]=tokenEnd[length]=length;
  for(let i=length-1;i>=0;i--){
    const char=css[i],space=/\s/u.test(char);
    nonWhite[i]=space?nonWhite[i+1]:i;
    doubleQuote[i]=char==='"'?i:doubleQuote[i+1];
    singleQuote[i]=char==="'"?i:singleQuote[i+1];
    tokenEnd[i]=space||char===')'?i:tokenEnd[i+1];
  }
  // A URL token has meaning only outside CSS comments and ordinary strings.
  // Track lexical scope independently of the legacy URL payload scanner.
  const active=new Uint8Array(length);
  let comment=false,quoted:string|null=null;
  for(let i=0;i<length;i++){
    const char=css[i],next=css[i+1];
    if(comment){if(char==='*'&&next==='/'){comment=false;i++;}continue;}
    if(quoted){
      if(char==='\\\\'){i++;continue;}
      if(char===quoted)quoted=null;
      continue;
    }
    if(char==='/'&&next==='*'){comment=true;i++;continue;}
    if(char==='"'||char==="'"){quoted=char;continue;}
    active[i]=1;
  }
  const opener=/url\(/gi;
  let position=0;
  while(position<length){
    opener.lastIndex=position;
    const found=opener.exec(css);
    if(!found)break;
    const start=found.index;
    if(!active[start]){position=start+4;continue;}
    const begin=nonWhite[start+4];
    let close=-1;
    let source='';
    if(css[begin]==='"'||css[begin]==="'"){
      const last=css[begin]==='"'?doubleQuote[begin+1]:singleQuote[begin+1];
      const end=nonWhite[last<length?last+1:length];
      if(last<length&&css[end]===')'){
        close=end;
        source=css.slice(begin+1,last);
      }
    }
    if(close<0){
      const stop=tokenEnd[begin];
      const end=nonWhite[stop];
      if(css[end]===')'){
        close=end;
        source=css.slice(begin,stop);
      }
    }
    if(close>=0){
      yield {start,end:close+1,text:css.slice(start,close+1),source};
      position=close+1;
    }else position=start+4;
  }
}
export function replaceCssUrls(css:string,replace:(match:CssUrlMatch)=>string):string{
  let cursor=0,result='';
  for(const match of cssUrlMatches(css)){
    result+=css.slice(cursor,match.start)+replace(match);
    cursor=match.end;
  }
  return result+css.slice(cursor);
}
