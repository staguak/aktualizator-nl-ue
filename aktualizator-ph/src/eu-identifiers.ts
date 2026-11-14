// Sector 6 includes judgments, opinions, orders and notices, with optional
// official summary suffixes. Keep identifiers separate from filesystem paths.
export const celexPattern=/^(?:[03]\d{4}[LRD]\d{4}(?:\(\d{2}\))?(?:-\d{8})?|1\d{4}[A-Z]\/TXT|6\d{4}[CTF][A-Z]\d{4}(?:\(\d{2}\))?(?:_[A-Z0-9]+)?)(?:R\(\d{2}\))?$/;
export function checkCelex(id:string):void{
  if(!celexPattern.test(id))throw new Error(`Unsupported CELEX identifier: ${id}`);
}
