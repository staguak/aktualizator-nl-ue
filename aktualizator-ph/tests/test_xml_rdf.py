import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from xml_validation import validate_rdf_graph, RejectedRdf, PinnedSchemas, validate_required

PREFIX = ('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
          'xmlns:c="http://publications.europa.eu/ontology/cdm#" '
          'xmlns:xsd="http://www.w3.org/2001/XMLSchema#">')


def source(body):
    return (PREFIX + body + '</rdf:RDF>').encode()


class RdfGraphTests(unittest.TestCase):
    def test_xml_wellformedness_is_not_rdf_grammar(self):
        raw = source('<rdf:Description rdf:about="https://official.example/work">'
                     '<c:work_date_document rdf:resource="https://official.example/date" '
                     'rdf:nodeID="also-a-node"/></rdf:Description>')
        with self.assertRaises(RejectedRdf):
            validate_rdf_graph(raw, 'https://official.example/work')

    def test_direct_facts_keep_lexical_values_multiple_dates_and_do_not_infer_effects(self):
        raw = source('<rdf:Description rdf:about="https://official.example/work">'
                     '<c:resource_legal_id_celex>32016R0679</c:resource_legal_id_celex>'
                     '<c:work_date_document rdf:datatype="http://www.w3.org/2001/XMLSchema#date">2025-01-01</c:work_date_document>'
                     '<c:work_date_document rdf:datatype="http://www.w3.org/2001/XMLSchema#date">2025-02-01</c:work_date_document>'
                     '<c:resource_legal_amends_resource_legal rdf:resource="https://official.example/other"/>'
                     '</rdf:Description>')
        result = validate_rdf_graph(raw, 'https://official.example/work', '32016R0679')
        self.assertEqual(result['identity'], 'CONFIRMED')
        self.assertEqual(len(result['facts']), 4)
        self.assertEqual(result['multipleValues'][0]['status'], 'MULTIPLE_VALUES_UNRESOLVED')
        self.assertNotIn('entryIntoForce', str(result))
        with self.assertRaises(RejectedRdf):
            validate_rdf_graph(raw, 'https://official.example/work', '32003L0088')
        with self.assertRaises(RejectedRdf):
            validate_rdf_graph(raw, 'https://official.example/unrelated', '32016R0679')

    def test_ill_typed_date_cannot_become_a_confirmed_legal_date(self):
        raw = source('<rdf:Description rdf:about="https://official.example/work">'
                     '<c:work_date_document rdf:datatype="http://www.w3.org/2001/XMLSchema#date">2025-02-30</c:work_date_document>'
                     '</rdf:Description>')
        with self.assertRaises(RejectedRdf):
            validate_rdf_graph(raw, 'https://official.example/work')

    def test_graph_parsing_never_dereferences_resource_links(self):
        raw = source('<rdf:Description rdf:about="https://official.example/work">'
                     '<c:resource_legal_amends_resource_legal rdf:resource="https://must-not-open.invalid/"/>'
                     '</rdf:Description>')
        with patch('socket.create_connection', side_effect=AssertionError('NETWORK_FORBIDDEN')):
            self.assertEqual(validate_rdf_graph(raw, 'https://official.example/work')['status'], 'PASS')

    def test_parser_infrastructure_failures_remain_fatal_instead_of_optional_source_rejection(self):
        for failure in (MemoryError('resource unavailable'), OSError('runtime unavailable'), RuntimeError('parser failed')):
            with self.subTest(type=type(failure).__name__), patch('xml_validation.Graph.parse', side_effect=failure):
                with self.assertRaises(type(failure)):
                    validate_rdf_graph(source(''), 'https://official.example/work')

    def test_graph_limit_is_enforced_during_insertion_without_counting_duplicate_statements(self):
        one='<rdf:Description rdf:about="https://official.example/work"><c:date>2025-01-01</c:date></rdf:Description>'
        with patch('xml_validation.MAX_RDF_TRIPLES', 1):
            self.assertEqual(validate_rdf_graph(source(one + one), 'https://official.example/work')['triples'], 1)
            with self.assertRaises(RejectedRdf):
                validate_rdf_graph(source(one + one.replace('2025-01-01', '2025-02-01')), 'https://official.example/work')

    def test_assertion_limit_stops_collection_before_building_an_oversized_evidence_list(self):
        raw=source('<rdf:Description rdf:about="https://official.example/work">'
                   '<c:resource_legal_id_celex>32016R0679</c:resource_legal_id_celex>'
                   '<c:work_date_document>2025-01-01</c:work_date_document></rdf:Description>')
        with patch('xml_validation.MAX_RDF_FACTS', 1), self.assertRaises(RejectedRdf):
            validate_rdf_graph(raw, 'https://official.example/work', '32016R0679')

    def test_repeated_celex_on_an_unrelated_subject_does_not_assign_its_date_to_returned_work(self):
        raw=source('<rdf:Description rdf:about="https://official.example/work">'
                   '<c:resource_legal_id_celex>32016R0679</c:resource_legal_id_celex>'
                   '<c:work_date_document>2025-01-01</c:work_date_document></rdf:Description>'
                   '<rdf:Description rdf:about="https://official.example/unrelated">'
                   '<c:resource_legal_id_celex>32016R0679</c:resource_legal_id_celex>'
                   '<c:work_date_document>2037-01-01</c:work_date_document></rdf:Description>')
        result=validate_rdf_graph(raw, 'https://official.example/work', '32016R0679')
        self.assertEqual(result['identity'], 'CONFIRMED')
        self.assertEqual(result['unrelatedCelexSubjects'], ['https://official.example/unrelated'])
        self.assertTrue(all(fact['subject'] == 'https://official.example/work' for fact in result['facts']))
        self.assertNotIn('2037-01-01', str(result['facts']))

    def test_rdf_graph_pass_remains_no_pinned_xsd_and_unknown_identity_for_legacy_sources(self):
        schemas = PinnedSchemas(Path(__file__).resolve().parents[1] / 'docs/schema-research')
        raw = source('<rdf:Description rdf:about="https://official.example/work"/>')
        result = validate_required(schemas, raw, 'https://official.example/work', 'CELLAR-RDF-tree')
        self.assertEqual(result['status'], 'NO_PINNED_SCHEMA')
        self.assertEqual(result['rdfGraph']['status'], 'PASS')
        self.assertEqual(result['rdfGraph']['identity'], 'NOT_CHECKED')
        with self.assertRaises(ValueError):
            validate_required(schemas, b'<!DOCTYPE rdf:RDF>' + raw, '', 'CELLAR-RDF-tree')


if __name__ == '__main__':
    unittest.main()
