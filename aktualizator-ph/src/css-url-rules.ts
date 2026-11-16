/** Linear-time lexer for CSS url(...) tokens, preserving the historical
 * permissive HTML/CSS extraction rule. No CSS bytes are rewritten here.
 */
export interface CssUrlMatch {
  start:number;
  end:number;
  text:string;
  source:string;
}
/** Recognize CSS identifier tokens, including escaped spellings of url. */
function* cssUrlOpeners(css:string):Generator<{start:number;after:number}>{
  const ident=(c:string)=>!!c&&(/[a-z0-9_-]/i.test(c)||c.charCodeAt(0)>=0x80);
  const hex=(c:string)=>!!c&&/[a-f0-9]/i.test(c);
  let i=0,comment=false,quote:string|null=null;
  while(i<css.length){
    const c=css[i],next=css[i+1];
    if(comment){
      if(c==='*'&&next==='/'){comment=false;i+=2;}else i++;
      continue;
    }
    if(quote){
      if(c==='\\'){i+=next===undefined?1:2;continue;}
      if(c===quote)quote=null;
      i++;continue;
    }
    if(c==='/'&&next==='*'){comment=true;i+=2;continue;}
    if(c==='"'||c==="'"){quote=c;i++;continue;}
    if(!ident(c)&&!(c==='\\'&&next!==undefined&&!/[\n\r\f]/.test(next))){i++;continue;}
    const start=i;
    let name='';
    while(i<css.length){
      const part=css[i];
      let character:string;
      if(part==='\\'&&i+1<css.length&&!/[\n\r\f]/.test(css[i+1])){
        i++;
        if(hex(css[i])){
          let digits='';
          for(let n=0;n<6&&hex(css[i]);n++)digits+=css[i++];
          const scalar=parseInt(digits,16);
          character=scalar>0&&scalar<=0x10ffff&&!(scalar>=0xd800&&scalar<=0xdfff)?
            String.fromCodePoint(scalar):'\ufffd';
          if(i<css.length&&/\s/u.test(css[i]))i++;
        }else character=css[i++];
      }else if(ident(part)){character=part;i++;}
      else break;
      if(name.length<=3)name+=character;
    }
    if(name.toLowerCase()==='url'&&css[i]==='(')yield {start,after:i+1};
  }
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
  let position=0;
  for(const opener of cssUrlOpeners(css)){
    if(opener.start<position)continue;
    const start=opener.start;
    const begin=nonWhite[opener.after];
    let close=-1,source='';
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
    }else position=opener.after;
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
