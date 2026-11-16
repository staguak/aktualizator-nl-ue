/** Scan the simple, non-nested CSS declarations recognized by legal sources.
 * Reproduces /([^{}]+)\\{([^{}]*)\\}/g without repeated backtracking on
 * long unmatched selectors. Complex rules remain uncertain as before.
 */
export function* simpleCssRules(css:string):Generator<readonly [string,string]>{
  let selectorStart=0,open=-1;
  for(let i=0;i<css.length;i++){
    const code=css.charCodeAt(i);
    if(code===123){ // {
      if(open>=0)selectorStart=open+1;
      open=i;
    }else if(code===125){ // }
      if(open>selectorStart)yield [css.slice(selectorStart,open),css.slice(open+1,i)];
      selectorStart=i+1;open=-1;
    }
  }
}
