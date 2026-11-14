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
