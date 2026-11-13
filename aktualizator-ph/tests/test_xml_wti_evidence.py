"""The independent WTI audit must detect omitted and duplicate assertions."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]


def payload():
    raw = b'<wetstechnische-informatie><wijzigingen><details><betreft>wijziging</betreft><publicatie jaar="2025">bron</publicatie></details></wijzigingen></wetstechnische-informatie>'
    fields = [dict(locator=locator, value=value, classification='OFFICIAL_VALUE') for locator, value in
              [('betreft[1]/text()', 'wijziging'), ('publicatie[1]/@jaar', '2025'), ('publicatie[1]/text()', 'bron')]]
    return dict(bytes=base64.b64encode(raw).decode(), wti=dict(source=dict(sha256=hashlib.sha256(raw).hexdigest()), events=[dict(
        locator='/wetstechnische-informatie[1]/wijzigingen[1]/details[1]', fields=fields,
        nativeLabel=dict(value='wijziging', locator='betreft[1]/text()'), state=None,
        date=None, scope='work', unitReference=None, legalEffect='UNRESOLVED')]))


def verify(value):
    return subprocess.run([sys.executable, '-I', str(ROOT / 'scripts/verify_unit_fields.py')],
                          input=json.dumps(value), text=True, capture_output=True, timeout=10)


class WtiEvidenceTests(unittest.TestCase):
    def test_complete_native_attribute_and_text_fields_pass(self):
        result = verify(payload())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['wtiFields'], 3)

    def test_omitted_attribute_or_text_is_rejected_even_when_all_supplied_locators_are_correct(self):
        for index in range(3):
            with self.subTest(index=index):
                value = payload()
                del value['wti']['events'][0]['fields'][index]
                self.assertNotEqual(verify(value).returncode, 0)

    def test_duplicate_field_cannot_replace_an_omitted_native_assertion(self):
        value = payload()
        value['wti']['events'][0]['fields'][1] = value['wti']['events'][0]['fields'][0]
        result = verify(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Duplicate WTI field evidence', result.stderr)

    def test_empty_and_cdata_split_native_labels_preserve_their_exact_text(self):
        for label in ['', 'wij<![CDATA[zig]]>ing']:
            with self.subTest(label=label):
                value = payload()
                raw = base64.b64decode(value['bytes']).replace(b'<betreft>wijziging</betreft>', b'<betreft>' + label.encode() + b'</betreft>')
                value['bytes'] = base64.b64encode(raw).decode()
                value['wti']['source']['sha256'] = hashlib.sha256(raw).hexdigest()
                if not label:
                    value['wti']['events'][0]['nativeLabel']['value'] = ''
                    del value['wti']['events'][0]['fields'][0]
                result = verify(value)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_mixed_text_requires_every_parent_and_child_assertion(self):
        value = payload()
        raw = b'<wetstechnische-informatie><wijzigingen><details>voor<betreft>wij<nadruk>zig</nadruk>ing</betreft>na<publicatie jaar="2025">bron</publicatie></details></wijzigingen></wetstechnische-informatie>'
        value['bytes'] = base64.b64encode(raw).decode()
        value['wti']['source']['sha256'] = hashlib.sha256(raw).hexdigest()
        event = value['wti']['events'][0]
        event['nativeLabel']['locator'] = 'string(betreft[1])'
        event['fields'] = [dict(locator=locator, value=text, classification='OFFICIAL_VALUE') for locator, text in
                           [('text()[1]', 'voor'), ('text()[2]', 'na'), ('betreft[1]/text()[1]', 'wij'), ('betreft[1]/text()[2]', 'ing'), ('betreft[1]/nadruk[1]/text()', 'zig'),
                            ('publicatie[1]/@jaar', '2025'), ('publicatie[1]/text()', 'bron')]]
        result = verify(value)
        self.assertEqual(result.returncode, 0, result.stderr)
        del event['fields'][0]
        self.assertNotEqual(verify(value).returncode, 0)


if __name__ == '__main__':
    unittest.main()
