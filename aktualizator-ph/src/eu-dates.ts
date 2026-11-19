import {isCalendarDate} from './calendar.js';
import type {EuDocument} from './eu-provider.js';

// Documentary dates are selection evidence, never individual legal effect dates.
export function documentDate(doc:EuDocument):string|null{
  if(doc.celex.startsWith('0')){
    const layer=doc.celex.match(/^0\d{4}[LRD]\d{4}(?:\(\d{2}\))?-(\d{4})(\d{2})(\d{2})(?:R\(\d{2}\))?$/)?.slice(1).join('-');
    return layer&&isCalendarDate(layer)?layer:null;
  }
  const dates=doc.metadata.work_date_document??[];
  return dates.length===1&&isCalendarDate(dates[0])?dates[0]:null;
}

interface BindingValue {type?:string;value:string;datatype?:string;'xml:lang'?:string}
export interface EuDateObservation {
  predicate:string;
  originalValue:string;
  type:string;
  datatype?:string;
  language?:string;
  normalizedValue?:string;
  precision?:'day';
  scope:{celex:string;work?:string};
  sourceUrl:string;
  sourceSha256:string;
  confidence:'official';
}

export function officialDateObservation(predicate:string,value:BindingValue,scope:EuDateObservation['scope'],
  sourceUrl:string,sourceSha256:string):EuDateObservation|undefined{
  if(!/date|period|duration/i.test(predicate)&&!/#(?:date|dateTime|gYear|gYearMonth|duration)$/.test(value.datatype??''))return;
  return {predicate,originalValue:value.value,type:value.type??'unspecified',
    ...value.datatype?{datatype:value.datatype}:{},
    ...value['xml:lang']?{language:value['xml:lang']}:{},
    ...isCalendarDate(value.value)?{normalizedValue:value.value,precision:'day'}:{},
    scope,sourceUrl,sourceSha256,confidence:'official'};
}
