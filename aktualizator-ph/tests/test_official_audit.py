import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('verify_official_output', Path(__file__).resolve().parents[1] / 'scripts/verify_official_output.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class OfficialAudit(unittest.TestCase):
    def fixture(self, directory, language='PL'):
        celex = '32024R0001'
        codes = {'EN': 'ENG', 'PL': 'POL', 'NL': 'NLD', 'FR': 'FRA'}
        entries, docs, members = [], [], {}
        work = 'https://publications.europa.eu/resource/cellar/12345678-1234-1234-1234-123456789012'
        for lang in ['EN', language] if language != 'EN' else ['EN']:
            rows = [dict(work={'value': work}, expression={'value': work+'.0001'}, manifestation={'value': work+'.0001.03'},
                         language={'value': 'http://publications.europa.eu/resource/authority/language/'+codes[lang]},
                         format={'value': 'xhtml'}, item={'value': work+'.0001.03/DOC_1'})]
            data = json.dumps({'results': {'bindings': rows}}).encode()
            metadata = dict(celex=celex, language=lang, work=work, rows=[{k: v['value'] for k, v in rows[0].items() if k != 'language'}])
            members[lang+'.json'] = data
            entries.append(dict(name=lang+'.json', kind='CELLAR-WEMI-index', metadata=metadata, size=len(data), md5=audit.md5(data)))
        data = b'\xef\xbb\xbf<html><body>Full official legal text</body></html>'
        members['text.xhtml'] = data
        entries.append(dict(name='text.xhtml', kind='CELLAR-XHTML', metadata=dict(celex=celex, language=language), size=len(data), md5=audit.md5(data)))
        docs.append(dict(celex=celex, language=language, sourceSha256=hashlib.sha256(data).hexdigest(), legalStructure={'profile':'legal-structure-v1'}))
        index = dict(identifier=celex, range={'from':'2024-01-01','to':'2026-11-14'}, entries=entries, warnings=[])
        with zipfile.ZipFile(directory/'source.zip','w') as archive:
            archive.writestr('manifest.json',json.dumps(index))
            for name, raw in members.items():archive.writestr(name,raw)
        archive = directory/'source.zip'
        record = dict(name=archive.name, size=archive.stat().st_size, md5=audit.md5(archive.read_bytes()), entryCount=len(entries))
        manifest = dict(jurisdiction='EU', officialSources={'originalBytes':True}, rangeFrom='2024-01-01', rangeTo='2026-11-14',
                        acts=[dict(celex=celex, files=[], sourceArchive=record, documents=docs)])
        for name in ['INDEX.md','REPORT.md']: (directory/name).write_text('Control\n')
        (directory/'manifest.json').write_text(json.dumps(manifest))

    def test_distinct_language_indexes_and_bom_bound_originals_pass_all_supported_text_languages(self):
        for language in ['EN','PL','NL','FR']:
            with self.subTest(language=language), tempfile.TemporaryDirectory() as tmp:
                directory=Path(tmp);self.fixture(directory,language)
                self.assertEqual(audit.audit(directory,'EU')['acts'],1)

    def test_language_index_cannot_claim_a_different_returned_language(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp);self.fixture(directory,'PL')
            manifest=json.loads((directory/'manifest.json').read_bytes())
            manifest['acts'][0]['documents'][0]['language']='FR'
            (directory/'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaises((AssertionError,KeyError)):audit.audit(directory,'EU')
