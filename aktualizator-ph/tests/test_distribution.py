import hashlib
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec=importlib.util.spec_from_file_location('create_distribution',Path(__file__).resolve().parents[1]/'scripts/create_distribution.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class Distribution(unittest.TestCase):
    def fixture(self, root):
        work=root/'work';rows=[]
        for module_name,folder in [('NL','output'),('UE','output-ue')]:
            directory=work/folder;directory.mkdir(parents=True)
            raw=b'<?xml version="1.0"?><original>Exact original bytes</original>\r\n'
            entry=dict(name='nested/source.xml',size=len(raw),md5=hashlib.md5(raw).hexdigest(),sha256=hashlib.sha256(raw).hexdigest())
            native=directory/'01_act.sources.zip'
            with zipfile.ZipFile(native,'w') as archive:
                archive.writestr('manifest.json',json.dumps({'entries':[entry]}))
                archive.writestr(entry['name'],raw)
            record=dict(name=native.name,size=native.stat().st_size,md5=hashlib.md5(native.read_bytes()).hexdigest(),distribution={'bundle':module_name+'-sources.zip','prefix':'01_act'})
            manifest=dict(jurisdiction='NL' if module_name=='NL' else 'EU',rangeFrom='2024-01-01',rangeTo='2026-11-14',acts=[dict(bwbId='act',files=[{'name':'act.md'}],sourceArchive=record)])
            (directory/'manifest.json').write_text(json.dumps(manifest));(directory/'act.md').write_text('Entire final law\n')
            for file in directory.iterdir():rows.append(dict(name=module_name+'/'+file.name,bytes=file.stat().st_size,sha256=hashlib.sha256(file.read_bytes()).hexdigest()))
        inventory=root/'inventory.json';inventory.write_text(json.dumps(rows))
        audit=root/'audit.json';audit.write_text(json.dumps({'status':'PASS'}))
        return work,inventory,audit

    def test_four_packages_have_one_source_bundle_per_corpus_and_exact_original_members(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);work,inventory,audit=self.fixture(root)
            target=root/'distribution';result=module.build(work,target,inventory,audit)
            self.assertEqual({r['name'] for r in result['files']},{'NL-results.zip','UE-results.zip','NL-sources.zip','UE-sources.zip'})
            with zipfile.ZipFile(target/'NL-sources.zip') as archive:
                self.assertEqual(archive.read('01_act/nested/source.xml'),b'<?xml version="1.0"?><original>Exact original bytes</original>\r\n')
                self.assertIn('BUNDLE_INDEX.json',archive.namelist())
            with zipfile.ZipFile(target/'NL-results.zip') as archive:
                self.assertIn('act.md',archive.namelist());self.assertNotIn('01_act.sources.zip',archive.namelist())

    def test_changed_frozen_file_fails_without_installing_a_partial_distribution(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);work,inventory,audit=self.fixture(root)
            (work/'output'/'act.md').write_text('Changed law\n')
            with self.assertRaises(Exception):module.build(work,root/'distribution',inventory,audit)
            self.assertFalse((root/'distribution').exists())

    def test_graphic_language_fallback_original_is_preserved_once_in_the_same_source_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);work,inventory,audit=self.fixture(root)
            original=b'\xef\xbb\xbf<html lang="pl">Exact original graphic context</html>\r\n';sha=hashlib.sha256(original).hexdigest()
            proof=dict(sourceSha256=sha,sourceDocumentBase64=base64.b64encode(original).decode())
            raw=json.dumps({'sources':[{'resolution':proof},{'resolution':proof}]}).encode();file=work/'output-ue'/'IMAGE_INDEX.json';file.write_bytes(raw)
            rows=json.loads(inventory.read_text());rows.append(dict(name='UE/IMAGE_INDEX.json',bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()));inventory.write_text(json.dumps(rows))
            module.build(work,root/'distribution',inventory,audit)
            with zipfile.ZipFile(root/'distribution'/'UE-sources.zip') as archive:
                name='image-fallback/'+sha+'.xhtml';self.assertEqual(archive.read(name),original);self.assertEqual(archive.namelist().count(name),1)

    def test_svg_original_and_dependency_are_preserved_once_in_the_same_source_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);work,inventory,audit=self.fixture(root)
            original=b'<svg xmlns="http://www.w3.org/2000/svg"><image href="figure.png"/></svg>\r\n'
            dependency=b'Native dependency bytes';sha=hashlib.sha256(original).hexdigest();child=hashlib.sha256(dependency).hexdigest()
            proof=dict(profile='self-contained-svg-v1',originalSha256=sha,originalBase64=base64.b64encode(original).decode(),resources=[dict(sha256=child,base64=base64.b64encode(dependency).decode())])
            raw=json.dumps({'sources':[{'derivation':proof},{'derivation':proof}]}).encode();file=work/'output-ue'/'IMAGE_INDEX.json';file.write_bytes(raw)
            rows=json.loads(inventory.read_text());rows.append(dict(name='UE/IMAGE_INDEX.json',bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()));inventory.write_text(json.dumps(rows))
            module.build(work,root/'distribution',inventory,audit)
            with zipfile.ZipFile(root/'distribution'/'UE-sources.zip') as archive:
                for digest,data in [(sha,original),(child,dependency)]:
                    name='image-dependencies/'+digest;self.assertEqual(archive.read(name),data);self.assertEqual(archive.namelist().count(name),1)
