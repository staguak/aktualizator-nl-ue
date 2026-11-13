import fs from 'node:fs';
import path from 'node:path';
import {isCalendarDate,warsawDate} from './calendar.js';
import {stableJson} from './output.js';
export const effectiveScopeJson=(scope:unknown):string=>stableJson(scope);
export function configFile(root:string,name:string,env:NodeJS.ProcessEnv=process.env):string{
  return path.join(env.LAW_CONFIG_DIR?path.resolve(env.LAW_CONFIG_DIR):path.join(root,'config'),name);
}
export function resolveRange(root:string,env:NodeJS.ProcessEnv=process.env,now=new Date()):{rangeFrom:string;rangeTo:string;observedOn:string}{
  const config=JSON.parse(fs.readFileSync(configFile(root,'aktualizator.json',env),'utf8'));
  if(config.schemaVersion!==1||config.timeZone!=='Europe/Warsaw')throw new Error('Invalid common updater configuration.');
  const observedOn=env.LAW_OBSERVED_ON??warsawDate(now),rangeFrom=env.LAW_RANGE_FROM??config.rangeFrom??observedOn,rangeTo=env.LAW_RANGE_TO??observedOn;
  if(!isCalendarDate(observedOn)||observedOn>warsawDate(now))throw new Error('Invalid frozen observation date.');
  if(!isCalendarDate(rangeFrom)||!isCalendarDate(rangeTo)||rangeFrom>rangeTo||rangeTo>observedOn)throw new Error('Invalid common date range or future end date.');
  return {rangeFrom,rangeTo,observedOn};
}
