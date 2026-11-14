import type {LegalSourceNode} from './legal-tree.js';

/** Resolve the source grid before HTML serialization: metadata alone cannot
 * keep a sparse CALS entry under its original header. Unknown placement fails. */
export function resolveCalsGrid(group:LegalSourceNode):void{
  const fail=()=>{throw new Error('Unsupported or inconsistent CALS table grid.');};
  const positive=(s:string|undefined,fallback?:number)=>{const n=s===undefined?fallback:Number(s);if(!Number.isSafeInteger(n)||(n??0)<1)fail();return n!;};
  const names=new Map<string,number>();let previous=0;
  for(const col of group.children.filter(n=>n.tag==='colspec')){
    const position=positive(col.attributes.colnum,previous+1);
    if(position<=previous)fail();previous=position;
    if(col.attributes.colname){if(names.has(col.attributes.colname))fail();names.set(col.attributes.colname,position);}
  }
  const cols=positive(group.attributes.cols,previous);if(cols<previous||cols>10000)fail();
  const spans=new Map<string,{first:number;last:number}>();
  const resolve=(name:string|undefined)=>{const n=name?names.get(name):undefined;if(!n)fail();return n!;};
  for(const spec of group.children.filter(n=>n.tag==='spanspec')){
    const name=spec.attributes.spanname,first=resolve(spec.attributes.namest),last=resolve(spec.attributes.nameend);
    if(!name||spans.has(name)||last<first||last>cols)fail();spans.set(name,{first,last});
  }
  const process=(container:LegalSourceNode)=>{
    const rows=container.children.filter(n=>n.tag==='row');const occupied=new Array<number>(cols+1).fill(0);
    for(const row of rows){
      let cursor=1;const output:LegalSourceNode[]=[];
      const empty=(column:number):LegalSourceNode=>({tag:'td',attributes:{'data-cals-empty-column':String(column)},children:[],locator:row.locator+'::empty['+column+']'});
      for(const cell of row.children){
        if(cell.tag!=='entry'){output.push(cell);continue;}
        while(cursor<=cols&&occupied[cursor])cursor++;
        let first=cursor,last=cursor;
        if(cell.attributes.spanname){const span=spans.get(cell.attributes.spanname);if(!span)fail();first=span!.first;last=span!.last;}
        else if(cell.attributes.namest||cell.attributes.nameend){first=resolve(cell.attributes.namest);last=resolve(cell.attributes.nameend);}
        else if(cell.attributes.colname){first=resolve(cell.attributes.colname);last=first;}
        if(first<cursor||last<first||last>cols)fail();
        for(let column=cursor;column<first;column++)if(!occupied[column])output.push(empty(column));
        for(let column=first;column<=last;column++)if(occupied[column])fail();
        const extra=cell.attributes.morerows===undefined?0:Number(cell.attributes.morerows);
        if(!Number.isSafeInteger(extra)||extra<0)fail();
        for(let column=first;column<=last;column++)occupied[column]=extra+1;
        if(last>first)cell.attributes.colspan=String(last-first+1);
        output.push(cell);cursor=last+1;
      }
      for(let column=cursor;column<=cols;column++)if(!occupied[column])output.push(empty(column));
      row.children=output;
      for(let column=1;column<=cols;column++)if(occupied[column])occupied[column]--;
    }
    if(occupied.some(n=>n>0))fail();
  };
  if(group.children.some(n=>n.tag==='row'))process(group);
  for(const section of group.children.filter(n=>['thead','tbody','tfoot'].includes(n.tag)))process(section);
}
