/** The public corpus prefers one English representation, then PL/NL/FR only. */
export const EU_LANGUAGE_ORDER = ['EN','PL','NL','FR'] as const;
export type EuLanguage = typeof EU_LANGUAGE_ORDER[number];
const codes:Record<EuLanguage,string>={EN:'ENG',PL:'POL',NL:'NLD',FR:'FRA'};
export const languageCode=(language:EuLanguage):string=>codes[language];
export const languageAccept=(language:EuLanguage):string=>languageCode(language).toLowerCase();
export function languageMatches(value:string,language:EuLanguage):boolean {
  const normalized=value.toLowerCase();
  return normalized===language.toLowerCase()||normalized===languageAccept(language)||normalized.startsWith(language.toLowerCase()+'-');
}
export function preferredEuLanguages(available?:string[]):EuLanguage[]{
  return EU_LANGUAGE_ORDER.filter(language=>!available?.length||available.some(uri=>uri.endsWith('/'+languageCode(language))));
}
/** Stop after the first usable representation; do not download all translations. */
export async function firstEuLanguage<T>(languages:readonly EuLanguage[],load:(language:EuLanguage)=>Promise<T>,isUnavailable:(error:unknown)=>boolean):Promise<{language:EuLanguage;value:T}> {
  let last:unknown;
  for(const language of languages){
    try{return {language,value:await load(language)};}catch(error){if(!isUnavailable(error))throw error;last=error;}
  }
  throw last??new Error('No supported EU language is available.');
}
export const unicodeLength=(value:string):number=>[...value].length;

export const EU_COUNTRY_MODULES={NL:{countryISO:'NL',officialLanguages:['NL'] as const}} as const;
export function publicEuLanguages(activeModules:readonly (keyof typeof EU_COUNTRY_MODULES)[]):EuLanguage[]{
  return [...new Set<EuLanguage>(['EN','FR',...activeModules.flatMap(id=>EU_COUNTRY_MODULES[id].officialLanguages)])];
}
export function publicEuModules(env:NodeJS.ProcessEnv=process.env):('NL')[]|undefined{
  const value=env.LAW_PUBLIC_EU_MODULES;
  if(value===undefined)return undefined;
  if(value==='')return [];
  if(value==='NL')return ['NL'];
  throw new Error('Unsupported active country module.');
}
export function euLanguageOrder():readonly EuLanguage[]{
  const modules=publicEuModules();
  return modules?publicEuLanguages(modules):EU_LANGUAGE_ORDER;
}
export function availableEuLanguages(values:readonly string[], languages:readonly EuLanguage[]){
  return languages.filter(language=>values.some(value=>
    /^https?:\/\/publications\.europa\.eu\/resource\/authority\/language\/[A-Z]{3}$/.test(value)&&
    value.endsWith('/'+languageCode(language))));
}
export function unsupportedEuLanguages(values:readonly string[],languages:readonly EuLanguage[]):boolean{
  return values.length>0&&values.every(value=>/^https?:\/\/publications\.europa\.eu\/resource\/authority\/language\/[A-Z]{3}$/.test(value))&&
    availableEuLanguages(values,languages).length===0;
}

export interface EuLanguageExclusion {
  celex:string;
  reason:string;
  availableLanguages?:string[];
  checkedLanguages?:EuLanguage[];
}
