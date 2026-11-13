// Historical corpus reader only. New generators and the Drive publisher require v2.
import { assertEuIntegrity, assertIntegrity, nlOutputIntegrity } from './content-integrity.js';
import { validateEuNavigation } from './eu-navigation.js';
import type { ValidationContext } from './validation-context.js';

export function validateLegacyContent(context: ValidationContext): void {
  const manifest = context.manifest, expectedActs = context.expectedActs;
  if (!['EU', 'NL'].includes(manifest.jurisdiction)) throw new Error('Invalid content validation jurisdiction.');
  for (const act of manifest.acts) {
    if (manifest.jurisdiction === 'NL') {
      if (!act.bwbId || act.celex) throw new Error('Invalid NL content identity.');
      assertIntegrity(act.integrity, nlOutputIntegrity(act.files.map((file: {name: string}) =>
        context.text(file.name))));
    } else {
      if (!act.celex || act.bwbId || !Array.isArray(act.documents) || !act.documents.length ||
          new Set(act.documents.map((doc: {celex: string}) => doc.celex)).size !== act.documents.length) {
        throw new Error('Incomplete EU document manifest.');
      }
      const expectedAct = expectedActs.find((item) => item.order === act.order)!;
      for (const id of [...expectedAct.requiredVersions ?? [], ...expectedAct.attachedDocuments?.map((doc) => doc.celex) ?? []]) {
        if (!act.documents.some((doc: {celex: string}) => doc.celex === id)) throw new Error('Missing required EU document.');
      }
      if (act.files.some((file: {celex: string}) => !act.documents.some((doc: {celex: string}) => doc.celex === file.celex))) {
        throw new Error('Unexpected EU part identity.');
      }
      for (const doc of act.documents) {
        const parts = act.files.filter((file: {celex: string}) => file.celex === doc.celex)
          .sort((a: {part: number}, b: {part: number}) => a.part - b.part);
        if (!parts.length || parts.some((part: {part: number}, i: number) => part.part !== i + 1) ||
            !/^[a-f0-9]{64}$/.test(doc.sourceSha256)) throw new Error('Incomplete EU parts/source identity.');
        const contents = parts.map((part: {name: string; part: number}) => {
          const content = context.text(part.name);
          const marker = `<!-- Część ${part.part}/${parts.length} -->\n\n`;
          if (content.split(marker).length !== 2 || !content.endsWith('\n')) throw new Error('Invalid EU part boundaries.');
          return content.split(marker)[1].slice(0, -1);
        });
        assertEuIntegrity(doc.integrity, contents.join('\n'));
        if (doc.textLength !== contents.reduce((n: number, content: string) => n + content.length, 0)) {
          throw new Error('EU text length differs from manifest.');
        }
        validateEuNavigation(contents, parts.map((part: {name: string}) => part.name));
      }
    }
  }
}
