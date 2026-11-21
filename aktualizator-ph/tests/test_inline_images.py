import base64
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('verify_inline_images', Path(__file__).resolve().parents[1]/'scripts/verify_inline_images.py')
inline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inline)
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC')


class InlineImages(unittest.TestCase):
    def test_contextual_image_source_key(self):
        source = {'requestUrl': 'https://publications.europa.eu/resource/celex/01992L0058-20190726.ENG.xhtml.r1.jpg',
                  'resolution': {'documentId': '01992L0058-20190726', 'version': '01992L0058-20190726',
                                 'language': 'FR', 'sourceUrl': 'https://eur-lex.europa.eu/',
                                 'sourceSha256': '3'*64, 'sourceLocator': 'img[1]'}}
        self.assertNotEqual(inline.image_source_key(source, 'legal-images-v2'), inline.image_source_key(source, 'legal-images-v1'))

    def fixture(self, directory):
        url = 'https://publications.europa.eu/image.png'
        body = '<p>A🧾 legal text.</p><img alt="Exact drawing" src="'+url+'">'
        canonical = '# Original 😀\n\n'+inline.START+body+inline.END+'\n'
        uri = 'data:image/png;base64,'+base64.b64encode(PNG).decode()
        rendered = canonical.replace(url, uri)
        a = inline.units(canonical[:canonical.index(url)])
        patch = dict(canonicalStart=a,canonicalEnd=a+len(url),renderedStart=a,renderedEnd=a+len(uri),original=url,renderedSha256=inline.sha(uri))
        asset = 'images/'+inline.sha(PNG)+'.png'
        image = dict(markdownFile='act.md',offset=inline.units(body[:body.index('<img')]),end=inline.units(body),occurrence=0,kind='img',target=asset,sourceUrl='https://publications.europa.eu/act.xhtml')
        record = dict(name='act.md',canonicalSha256=inline.sha(canonical),renderedSha256=inline.sha(rendered),patches=[patch])
        index = dict(profile='legal-images-v1',assets=[dict(name=asset,sha256=inline.sha(PNG),bytes=len(PNG),contentType='image/png')],sources=[dict(requestUrl=url,sha256=inline.sha(PNG))],occurrences=[image],rendering=dict(profile='inline-base64-v1',offsetEncoding='utf16-code-units',patchScope='full-markdown',legalOffsetScope='restored-canonical-body',files=[record]))
        (directory/'images').mkdir();(directory/asset).write_bytes(PNG);(directory/'act.md').write_text(rendered)
        return canonical, rendered, index, [dict(parts=[dict(file='act.md')])]

    def test_native_payload_and_unicode_offsets_restore_exact_canonical_markdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);canonical, rendered, index, documents=self.fixture(p)
            self.assertEqual(inline.restore('act.md', rendered,index),canonical)
            self.assertEqual(inline.audit_inline(p,index,documents)['act.md'],canonical)

    def test_an_updated_checksum_cannot_hide_replacement_image_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);_,rendered,index,documents=self.fixture(p)
            old=base64.b64encode(PNG).decode();new=base64.b64encode(bytes([PNG[0]^1])+PNG[1:]).decode()
            changed=rendered.replace(old,new);record=index['rendering']['files'][0]
            record['renderedSha256']=inline.sha(changed)
            patch=record['patches'][0];patch['renderedSha256']=inline.sha(inline.cut(changed,patch['renderedStart'],patch['renderedEnd']))
            (p/'act.md').write_text(changed)
            with self.assertRaises(AssertionError):inline.audit_inline(p,index,documents)

    def test_reversible_edits_cannot_erase_or_change_legal_text_outside_graphics(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);canonical,rendered,index,documents=self.fixture(p)
            changed=rendered.replace('A🧾','B🧾');offset=inline.units(canonical[:canonical.index('A🧾')])
            record=index['rendering']['files'][0]
            record['patches'].insert(0,dict(canonicalStart=offset,canonicalEnd=offset+1,renderedStart=offset,renderedEnd=offset+1,original='A',renderedSha256=inline.sha('B')))
            record['renderedSha256']=inline.sha(changed);(p/'act.md').write_text(changed)
            self.assertEqual(inline.restore('act.md',changed,index),canonical)
            with self.assertRaisesRegex(AssertionError,'outside graphics'):inline.audit_inline(p,index,documents)

    def test_an_unencoded_external_url_is_not_a_final_image(self):
        for value in ['https://publications.europa.eu/a.png','data:image/png,bytes','data:image/png;base64,not_base64']:
            with self.subTest(value=value),self.assertRaises((AssertionError,ValueError)):inline.decoded(value)

    def test_image_alt_text_is_part_of_the_preserved_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);canonical,rendered,index,documents=self.fixture(p)
            changed=rendered.replace('Exact drawing','Other drawing');offset=inline.units(canonical[:canonical.index('Exact drawing')])
            record=index['rendering']['files'][0];delta=len('Other drawing')-len('Exact drawing')
            for patch in record['patches']:
                patch['renderedStart']+=delta;patch['renderedEnd']+=delta
            record['patches'].insert(0,dict(canonicalStart=offset,canonicalEnd=offset+len('Exact drawing'),renderedStart=offset,renderedEnd=offset+len('Other drawing'),original='Exact drawing',renderedSha256=inline.sha('Other drawing')))
            record['renderedSha256']=inline.sha(changed);(p/'act.md').write_text(changed)
            self.assertEqual(inline.restore('act.md',changed,index),canonical)
            with self.assertRaises(AssertionError):inline.audit_inline(p,index,documents)
