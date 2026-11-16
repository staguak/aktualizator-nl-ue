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
  const candidates:CssUrlMatch[]=[];
  const opener=/url\(/gi;
  let position=0;
  while(position<length){
    opener.lastIndex=position;
    const found=opener.exec(css);
    if(!found)break;
    const start=found.index;
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
      candidates.push({start,end:close+1,text:css.slice(start,close+1),source});
      position=close+1;

    }else position=start+4;
  }
  // Skip candidates inside comments and strings. Accepted URL tokens are
  // atomic for lexical scanning, including malformed legacy payloads.
  let scan=0,comment=false,quote:string|null=null;
  for(const candidate of candidates){
    for(;scan<candidate.start;scan++){
      const char=css[scan],next=css[scan+1];
      if(comment){if(char==='*'&&next==='/'){comment=false;scan++;}continue;}
      if(quote){
        if(char==='\\'){scan++;continue;}
        if(char===quote)quote=null;
        continue;
      }
      if(char==='/'&&next==='*'){comment=true;scan++;continue;}
      if(char==='"'||char==="'"){quote=char;continue;}
    }
    if(!comment&&!quote){yield candidate;scan=candidate.end;}
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
