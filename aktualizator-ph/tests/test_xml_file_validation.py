import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from lxml import etree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import xml_validation as validator

NS = 'http://docs.oasis-open.org/ns/search-ws/sruResponse'
SCHEMA = 'http://docs.oasis-open.org/search-ws/searchRetrieve/v1.0/os/schemas/sruResponse.xsd'
XSI = 'http://www.w3.org/2001/XMLSchema-instance'
RDF = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:c="http://publications.europa.eu/ontology/cdm#" xmlns:owl="http://www.w3.org/2002/07/owl#">'


def sru(value):
    return (f'<s:searchRetrieveResponse xmlns:s="{NS}" xmlns:xsi="{XSI}" '
            f'xsi:schemaLocation="{NS} {SCHEMA}"><s:numberOfRecords>{value}'
            '</s:numberOfRecords></s:searchRetrieveResponse>').encode()


class StreamingFileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schemas = validator.PinnedSchemas(ROOT / 'docs/schema-research')

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='xml-file-test-')
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)

    def validate(self, path, kind='CELLAR-RDF-tree', identifier=None, url='https://official.example/work', digest=None):
        if digest is None:
            with path.open('rb') as handle:
                digest = hashlib.file_digest(handle, 'sha256').hexdigest()
        with validator._file_validation.open_source_file(str(path), [self.directory]) as source:
            return validator._file_validation.validate_file_stream(
                self.schemas, source, url, kind, identifier, digest,
                validator.assert_source_identity, validator.DenyExternal, validator.schema_matches_kind,
                validator.RejectedRdf, validator.PROFILE, validator.RDF_PROFILE, validator.MAX_RDF_FACTS)

    def write(self, raw):
        path = self.directory / 'source.xml'
        path.write_bytes(raw)
        return path

    def test_real_xsd_validation_runs_after_streaming_xml_inspection(self):
        raw = sru('3')
        path = self.write(raw)
        receipt = self.validate(path, 'SRU-2.0')
        self.assertEqual(receipt['status'], 'PASS')
        self.assertEqual(receipt['validationMode'], 'STREAMING_FILE')
        self.assertEqual(receipt['sourceSha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(len(receipt['schemaSha256']), 64)
        self.assertEqual(path.read_bytes(), raw)
        # A custom lxml parser target silently ignores schema=...; this case
        # ensures the actual second schema pass cannot accidentally be omitted.
        invalid = self.validate(self.write(sru('not-a-number')), 'SRU-2.0')
        self.assertEqual(invalid['status'], 'XSD_ERROR')
        self.assertNotIn('not-a-number', str(invalid))

    def test_missing_schema_is_not_falsely_reported_as_xsd_pass(self):
        path = self.write(sru('0').replace(SCHEMA.encode(), b'https://invalid.example/next.xsd'))
        self.assertEqual(self.validate(path, 'SRU-2.0')['status'], 'SCHEMA_REQUIRED')

    def test_file_exceeding_old_64mb_limit_uses_bounded_streaming_syntax(self):
        path = self.directory / 'large.xml'
        record = b'<x>' + b'a' * 1024 + b'</x>'
        with path.open('wb') as out:
            out.write(b'<work label="BWBR0000001">')
            block = record * 1024
            for _ in range(62):
                out.write(block)
            out.write(b'</work>')
        self.assertGreater(path.stat().st_size, 64_000_000)
        receipt = self.validate(path, 'BWB-manifest', 'BWBR0000001')
        self.assertEqual(receipt['status'], 'NO_PINNED_SCHEMA')
        self.assertEqual(receipt['sourceBytes'], path.stat().st_size)

    def test_invalid_end_of_file_and_dtd_entities_are_rejected(self):
        for raw in (b'<work label="BWBR0000001"><x>ok</x></other>',
                    b'<!DOCTYPE work [<!ENTITY x SYSTEM "file:///must-not-read">]><work label="BWBR0000001">&x;</work>'):
            with self.subTest(raw=raw[:20]), self.assertRaises((ValueError, etree.LxmlError)):
                self.validate(self.write(raw), 'BWB-manifest', 'BWBR0000001')

    def test_hash_mismatch_and_unsafe_paths_fail_before_graph_use(self):
        path = self.write(b'<work label="BWBR0000001"/>')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.validate(path, 'BWB-manifest', 'BWBR0000001', digest='0' * 64)
        outside = self.directory.parent / (self.directory.name + '-outside.xml')
        outside.write_bytes(b'<work/>')
        self.addCleanup(lambda: outside.unlink(missing_ok=True))
        with self.assertRaisesRegex(ValueError, 'outside'):
            validator._file_validation.open_source_file(str(outside), [self.directory])
        link = self.directory / 'link.xml'
        link.symlink_to(path)
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            validator._file_validation.open_source_file(str(link), [self.directory])
        parent_link = self.directory / 'linked'
        real = self.directory / 'real'
        real.mkdir()
        parent_link.symlink_to(real, target_is_directory=True)
        (real / 'x.xml').write_bytes(b'<x/>')
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            validator._file_validation.open_source_file(str(parent_link / 'x.xml'), [self.directory])

    def test_sqlite_graph_preserves_alias_facts_and_excludes_unrelated_celex(self):
        raw = (RDF + '<rdf:Description rdf:about="https://official.example/work">'
               '<owl:sameAs rdf:resource="https://official.example/oj"/>'
               '<owl:sameAs rdf:resource="https://official.example/celex"/></rdf:Description>'
               '<rdf:Description rdf:about="https://official.example/celex">'
               '<c:resource_legal_id_celex>32003L0088</c:resource_legal_id_celex></rdf:Description>'
               '<rdf:Description rdf:about="https://official.example/oj">'
               '<c:work_date_document>2003-11-04</c:work_date_document></rdf:Description>'
               '<rdf:Description rdf:about="https://official.example/unrelated">'
               '<c:resource_legal_id_celex>32003L0088</c:resource_legal_id_celex>'
               '<c:work_date_document>2099-01-01</c:work_date_document></rdf:Description></rdf:RDF>').encode()
        receipt = self.validate(self.write(raw), identifier='32003L0088')
        graph = receipt['rdfGraph']
        self.assertEqual(receipt['status'], 'NO_PINNED_SCHEMA')
        self.assertEqual(graph['identity'], 'CONFIRMED')
        self.assertEqual(graph['storage'], 'SQLITE_STREAMING_FILE')
        self.assertIn('2003-11-04', str(graph['facts']))
        self.assertNotIn('2099-01-01', str(graph['facts']))
        self.assertEqual(graph['unrelatedCelexSubjects'], ['https://official.example/unrelated'])

    def test_file_graph_has_no_legacy_250k_ceiling_and_deduplicates_statements(self):
        body = ('<rdf:Description rdf:about="https://official.example/work">'
                '<c:resource_legal_id_celex>32003L0088</c:resource_legal_id_celex>'
                '<c:work_date_document>2025-01-01</c:work_date_document>'
                '<c:work_date_document>2025-01-01</c:work_date_document></rdf:Description>')
        path = self.write((RDF + body + '</rdf:RDF>').encode())
        with patch('xml_validation.MAX_RDF_TRIPLES', 1):
            self.assertEqual(self.validate(path, identifier='32003L0088')['rdfGraph']['triples'], 2)
            with self.assertRaises(validator.RejectedRdf):
                validator.validate_rdf_graph(path.read_bytes(), 'https://official.example/work', '32003L0088')

    def test_graph_grammar_typed_literals_identity_and_offline_boundaries_remain_enforced(self):
        cases = [
            '<rdf:Description rdf:about="https://official.example/work"><c:date rdf:resource="https://x.invalid/" rdf:nodeID="both"/></rdf:Description>',
            '<rdf:Description rdf:about="https://official.example/unrelated"><c:date rdf:datatype="http://www.w3.org/2001/XMLSchema#date">2025-02-30</c:date></rdf:Description>',
        ]
        for body in cases:
            with self.subTest(body=body[:30]), self.assertRaises(validator.RejectedRdf):
                self.validate(self.write((RDF + body + '</rdf:RDF>').encode()))
        raw = (RDF + '<rdf:Description rdf:about="https://official.example/work">'
               '<c:resource_legal_id_celex>32003L0088</c:resource_legal_id_celex>'
               '<c:amends rdf:resource="https://must-not-connect.invalid/"/></rdf:Description></rdf:RDF>').encode()
        with patch('socket.create_connection', side_effect=AssertionError('NETWORK_FORBIDDEN')):
            self.assertEqual(self.validate(self.write(raw), identifier='32003L0088')['rdfGraph']['identity'], 'CONFIRMED')
        with self.assertRaisesRegex(validator.RejectedRdf, 'CELEX'):
            self.validate(self.write(raw), identifier='32016R0679')


if __name__ == '__main__':
    unittest.main()
