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
