import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
from lxml import etree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from xml_validation import PinnedSchemas, validate_required, safe_parser, checked_zip, check_runtime

NS = 'http://docs.oasis-open.org/ns/search-ws/sruResponse'
SRU = 'http://docs.oasis-open.org/search-ws/searchRetrieve/v1.0/os/schemas/sruResponse.xsd'
XSI = 'http://www.w3.org/2001/XMLSchema-instance'


def sru(value='0', location=SRU):
    return (f'<s:searchRetrieveResponse xmlns:s="{NS}" xmlns:xsi="{XSI}" '
            f'xsi:schemaLocation="{NS} {location}"><s:numberOfRecords>{value}'
            '</s:numberOfRecords></s:searchRetrieveResponse>').encode()


class RuntimeXmlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        check_runtime()
        cls.schemas = PinnedSchemas(ROOT / 'docs/schema-research')

    def test_valid_sru_records_exact_byte_and_schema_hashes(self):
        raw = sru()
        receipt = validate_required(self.schemas, raw, 'https://zoekservice.overheid.nl/sru/Search', 'SRU-2.0')
        self.assertEqual(receipt['status'], 'PASS')
        self.assertEqual(receipt['sourceSha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(len(receipt['schemaSha256']), 64)
        self.assertEqual(receipt['sourceBytes'], len(raw))

    def test_schema_invalid_sru_is_rejected_before_application_parser(self):
        receipt = validate_required(self.schemas, sru('not-a-number'), '', 'SRU-2.0')
        self.assertEqual(receipt['status'], 'XSD_ERROR')
        self.assertTrue(receipt['errors'])
        self.assertNotIn('not-a-number', json.dumps(receipt))

    def test_native_formex_0520_uses_the_exact_official_schema(self):
        sha = '90ba33960712e7e1e637152d4bc1e7329cc8dc935f97840c44ff99d5ff9a1f1d'
        cases = [
            ('DOC', '303f18dc09dc44d6128a45fde1a65d75bdc6ca21e2d383a1e8c92b8adedea1be'),
            ('PUBLICATION', '1a916084007e94b7691910775e3bddc67095ef8df12b32b964e7776aec2504f7'),
        ]
        for root, digest in cases:
            with self.subTest(root=root):
                raw = (ROOT / 'src/fixtures' / f'formex-0520-native-{root.lower()}.xml').read_bytes()
                receipt = validate_required(self.schemas, raw, 'https://publications.europa.eu/', 'CELLAR-Formex4')
                self.assertEqual(receipt['status'], 'PASS')
                self.assertEqual(receipt['root'], root)
                self.assertEqual(receipt['sourceSha256'], digest)
                self.assertEqual(receipt['schemaSha256'], sha)

    def test_native_formex_0501_uses_the_exact_official_schema(self):
        raw = (ROOT / 'src/fixtures/formex-0501-native-doc.xml').read_bytes()
        receipt = validate_required(self.schemas, raw, 'https://publications.europa.eu/', 'CELLAR-Formex4')
        self.assertEqual(receipt['status'], 'PASS')
        self.assertEqual(receipt['sourceSha256'], 'e5f653e0605e3c42427928cb7d9122d80328b3e5e931c15c59bc0fd40d53c3bf')
        self.assertEqual(receipt['schemaSha256'], '8f99b87e6eab025c8d729eed410a75a0242ad1a1109adfcc21b39b539ab98314')

    def test_native_formex_0555_uses_the_exact_official_schema(self):
        raw = (ROOT / 'src/fixtures/formex-0555-native-doc.xml').read_bytes()
        receipt = validate_required(self.schemas, raw, 'https://publications.europa.eu/', 'CELLAR-Formex4')
        self.assertEqual(receipt['status'], 'PASS')
        self.assertEqual(receipt['sourceSha256'], 'c87586800b718b49a6a8a0c76a5ccd1eecb7e5c35288bca6694f44b185e95632')
        self.assertEqual(receipt['schemaSha256'], '868e7a1675a6bbb7c6fe5a1e63df6e88e1fd98f605720be47d46c9e1cd38c51d')

    def test_unknown_schema_is_not_replaced_with_a_known_version(self):
        receipt = validate_required(self.schemas, sru(location='https://example.invalid/next.xsd'), '', 'SRU-2.0')
        self.assertEqual(receipt['status'], 'SCHEMA_REQUIRED')

    def test_missing_required_schema_is_not_a_pass(self):
        raw = f'<s:searchRetrieveResponse xmlns:s="{NS}"><s:numberOfRecords>0</s:numberOfRecords></s:searchRetrieveResponse>'.encode()
        self.assertEqual(validate_required(self.schemas, raw, '', 'SRU-2.0')['status'], 'SCHEMA_REQUIRED')

    def test_rdf_and_undeclared_manifest_remain_explicit_xml_only(self):
        rdf = b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>'
        self.assertEqual(validate_required(self.schemas, rdf, '', 'CELLAR-RDF-tree')['status'], 'NO_PINNED_SCHEMA')
        manifest = b'<work label="BWBR0000001"/>'
        self.assertEqual(validate_required(self.schemas, manifest, '', 'BWB-manifest', 'BWBR0000001')['status'], 'NO_PINNED_SCHEMA')

    def test_bwb_root_and_identifier_must_match_even_for_xml_only(self):
        for raw in [b'<work label="BWBR0000002"/>', b'<other label="BWBR0000001"/>']:
            with self.assertRaisesRegex(ValueError, 'identity'):
                validate_required(self.schemas, raw, '', 'BWB-manifest', 'BWBR0000001')

    def test_permissive_sru_cannot_be_used_as_a_formex_schema(self):
        with self.assertRaisesRegex(ValueError, 'family'):
            validate_required(self.schemas, sru(), '', 'CELLAR-Formex4')

    def test_namespace_and_schema_location_ambiguities_fail(self):
        for raw in [sru().replace(f'{NS} {SRU}'.encode(), f'{NS} {SRU} {NS} {SRU}'.encode()),
                    sru().replace(f'{NS} {SRU}'.encode(), NS.encode())]:
            with self.assertRaises(ValueError):
                validate_required(self.schemas, raw, '', 'SRU-2.0')

    def test_dtd_entities_and_external_resources_are_never_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            secret = Path(tmp) / 'secret.txt'
            secret.write_text('SECRET_CANNOT_ENTER_XML')
            for declaration in [f'<!DOCTYPE work SYSTEM "{secret.as_uri()}">',
                                f'<!DOCTYPE work [<!ENTITY x SYSTEM "{secret.as_uri()}">]>',
                                '<!DOCTYPE work [<!ENTITY x "expanded">]>']:
                with self.assertRaisesRegex(ValueError, 'DTD'):
                    validate_required(self.schemas, (declaration+'<work label="BWBR0000001"/>').encode(), '', 'BWB-manifest', 'BWBR0000001')
            with self.assertRaisesRegex(ValueError, 'forbidden'):
                etree.parse(str(secret), safe_parser())

    def test_changed_catalog_is_rejected_before_schema_compilation(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            directory.joinpath('catalog.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'catalog digest'):
                PinnedSchemas(directory)

    def test_duplicate_zip_names_are_rejected_before_collapsing_to_a_map(self):
        import warnings
        raw = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(raw, 'w') as z:
                z.writestr('a.xml', '<a/>')
                z.writestr('a.xml', '<b/>')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            checked_zip(raw.getvalue())

    def test_corrupt_crc_and_unsafe_zip_paths_are_rejected(self):
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, 'w') as z:
            z.writestr('../a.xml', '<a/>')
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            checked_zip(raw.getvalue())
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, 'w', compression=zipfile.ZIP_STORED) as z:
            z.writestr('a.xml', 'UNIQUE_XML_PAYLOAD')
        corrupted = raw.getvalue().replace(b'UNIQUE_XML_PAYLOAD', b'BROKEN_XML_PAYLOD!')
        with self.assertRaisesRegex(ValueError, 'CRC'):
            checked_zip(corrupted)


if __name__ == '__main__':
    unittest.main()
