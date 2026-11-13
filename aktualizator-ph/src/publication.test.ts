import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { validateOutput, verifyRemoteFiles } from './publication-validation.js';
import { parseOAuthSecret, validateScopes, DRIVE_FILE_SCOPE } from './drive-auth.js';

const acts = [{ order: 1, bwbId: 'BWBR0005290' }];
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const content = '# Test\nArtikel 610\n';
  const manifest = { schemaVersion: 1, acts: [{ ...acts[0], files: [{
    name: '01_act.md', md5: createHash('md5').update(content).digest('hex'),
  }] }] };
  fs.writeFileSync(path.join(dir, '01_act.md'), content);
  fs.writeFileSync(path.join(dir, 'INDEX.md'), '# Index\n');
  fs.writeFileSync(path.join(dir, 'REPORT.md'), '# Report\n');
  const save = () => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  save();
  return { dir, manifest, save };
}

test('accepts a complete manifest with matching bytes', (t) => {
  const { dir } = fixture(t);
  assert.equal(validateOutput(dir, acts).length, 4);
});
test('EU manifests use CELEX identity and reject a mismatched or ambiguous source', (t) => {
  const { dir, manifest } = fixture(t);
  const eu = { schemaVersion: 1, acts: [{ order: 1, celex: '32008L0104', files: manifest.acts[0].files }] };
  const save = () => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(eu));
  save();
  assert.equal(validateOutput(dir, [{ order: 1, celex: '32008L0104' }]).length, 4);
  assert.throws(() => validateOutput(dir, [{ order: 1, celex: '32003L0088' }]));
  Object.assign(eu.acts[0], { bwbId: 'BWBR0005290' }); save();
  assert.throws(() => validateOutput(dir, [{ order: 1, celex: '32008L0104' }]));
});
test('rejects a package missing a configured act', (t) => {
  const { dir } = fixture(t);
  assert.throws(() => validateOutput(dir, [...acts, { order: 2, bwbId: 'BWBR0000001' }]));
});
test('rejects duplicate or unexpected acts', (t) => {
  const { dir, manifest, save } = fixture(t);
  manifest.acts.push(manifest.acts[0]); save();
  assert.throws(() => validateOutput(dir, [...acts, { order: 2, bwbId: 'BWBR0000001' }]));
  manifest.acts = [{ ...manifest.acts[0], bwbId: 'OTHER' }]; save();
  assert.throws(() => validateOutput(dir, acts));
});
test('rejects missing and unexpected files', (t) => {
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'unexpected.txt'), 'extra');
  assert.throws(() => validateOutput(dir, acts));
  fs.unlinkSync(path.join(dir, 'unexpected.txt'));
  fs.unlinkSync(path.join(dir, 'INDEX.md'));
  assert.throws(() => validateOutput(dir, acts));
});
test('rejects modified content and empty reports', (t) => {
  const { dir } = fixture(t);
  const file = path.join(dir, '01_act.md');
  const original = fs.readFileSync(file);
  fs.appendFileSync(file, 'corruption');
  assert.throws(() => validateOutput(dir, acts));
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(dir, 'REPORT.md'), '');
  assert.throws(() => validateOutput(dir, acts));
});
test('rejects traversal paths and duplicate file names', (t) => {
  const { dir, manifest, save } = fixture(t);
  manifest.acts[0].files[0].name = '../01_act.md'; save();
  assert.throws(() => validateOutput(dir, acts));
  manifest.acts[0].files[0].name = '01_act.md';
  manifest.acts[0].files.push(manifest.acts[0].files[0]); save();
  assert.throws(() => validateOutput(dir, acts));
});
test('rejects symlinks instead of corpus files', (t) => {
  const { dir } = fixture(t);
  fs.unlinkSync(path.join(dir, 'INDEX.md'));
  fs.symlinkSync(path.join(dir, 'REPORT.md'), path.join(dir, 'INDEX.md'));
  assert.throws(() => validateOutput(dir, acts));
});
test('accepts matching remote metadata and rejects upload defects', (t) => {
  const { dir } = fixture(t);
  const local = validateOutput(dir, acts);
  const remote = local.map((file, i) => ({
    id: String(i), name: file.name, md5Checksum: file.md5, size: String(file.size), parents: ['folder'],
  }));
  assert.doesNotThrow(() => verifyRemoteFiles(local, remote, 'folder'));
  assert.throws(() => verifyRemoteFiles(local, remote.slice(1), 'folder'));
  for (const change of [
    { md5Checksum: 'wrong' }, { size: '0' }, { parents: ['other'] }, { id: '' }, { name: 'extra.md' },
  ]) {
    assert.throws(() => verifyRemoteFiles(local, [{ ...remote[0], ...change }, ...remote.slice(1)], 'folder'));
  }
  assert.throws(() => verifyRemoteFiles(local, [remote[1], ...remote.slice(1)], 'folder'));
});
test('OAuth parsing rejects invalid input without echoing credentials', () => {
  for (const raw of [undefined, '{', 'null', '[]', '{}', '{"client_secret":"do-not-print"}',
    '{"client_id":"id","client_secret":"secret","refresh_token":" "}']) {
    assert.throws(() => parseOAuthSecret(raw), (error: unknown) =>
      error instanceof Error && !error.message.includes('do-not-print'));
  }
  assert.equal(parseOAuthSecret('{"client_id":"id","client_secret":"secret","refresh_token":"refresh"}').client_id, 'id');
});
test('accepts only drive.file and rejects broad or additional scopes', () => {
  assert.doesNotThrow(() => validateScopes([DRIVE_FILE_SCOPE]));
  for (const scopes of [[], ['https://www.googleapis.com/auth/drive'], [DRIVE_FILE_SCOPE, 'openid']]) {
    assert.throws(() => validateScopes(scopes));
  }
});
