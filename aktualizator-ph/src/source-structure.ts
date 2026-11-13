export interface SourceStructure {
  snapshots:number;unitObservations:number;editorialCorrections:number;corrigendumSnapshots:number;alternateRepresentations:number;
}
export function sourceStructure(index:any):SourceStructure{
  let snapshots=0,unitObservations=0,editorialCorrections=0,corrigendumSnapshots=0;
  const representations=new Map<string,Set<string>>();
  for(const entry of index.entries){
    const m=entry.metadata;
    if(Array.isArray(m?.units)){snapshots++;unitObservations+=m.units.length;editorialCorrections+=(m.unitCorrections??[]).length;}
    for(const snapshot of m?.unitHistory??[]){snapshots++;unitObservations+=snapshot.units.length;editorialCorrections+=snapshot.corrections.length;
      if(snapshot.root==='CORR')corrigendumSnapshots++;}
    // Only a source's own explicit document ID can group representations.
    if(typeof m?.celex==='string'&&['CELLAR-XHTML','CELLAR-Formex4','EUR-Lex-HTML'].includes(entry.kind)){
      const kinds=representations.get(m.celex)??new Set<string>();kinds.add(entry.kind);representations.set(m.celex,kinds);
    }
  }
  return {snapshots,unitObservations,editorialCorrections,corrigendumSnapshots,
    alternateRepresentations:[...representations.values()].reduce((n,kinds)=>n+Math.max(0,kinds.size-1),0)};
}
