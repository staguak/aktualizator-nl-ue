export interface ValidationResult {
  status: 'PENDING' | 'PASS' | 'FAIL';
  checks: string[];
  fileCount: number;
  contentFileCount: number;
  contentBytes: number;
  error?: string;
  sourceStructure?:import('./source-structure.js').SourceStructure;
  sourceAvailability?:import('./source-availability.js').SourceAvailability[];
}
export const pendingValidation = (): ValidationResult => ({status:'PENDING',checks:[],fileCount:0,contentFileCount:0,contentBytes:0});
export function requireReportStatus(text: string, status: 'PENDING' | 'PASS'): void {
  const matches = [...text.matchAll(/^Walidacja: (PASS|PENDING|FAIL) — /gm)];
  if (matches.length !== 1 || matches[0][1] !== status) throw new Error('Final report does not record successful validation.');
}
export function reportValidation(result: ValidationResult): string {
  if (result.status === 'PENDING') return 'Walidacja: PENDING — końcowe kontrole jeszcze niewykonane. Publikacja jest zablokowana.';
  if (result.status === 'FAIL') return `Walidacja: FAIL — ${result.error ?? 'końcowa kontrola odrzuciła zestaw'}. Publikacja jest zablokowana.`;
  return `Walidacja: PASS — ${result.checks.join(', ')}. Sprawdzone pliki: ${result.fileCount}; pliki treści: ${result.contentFileCount}; bajty treści: ${result.contentBytes}.`;
}
