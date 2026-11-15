import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from verify_eu_headers import source_title,expected_header,verify_header


class EuHeaders(unittest.TestCase):
    url='https://publications.europa.eu/document.xhtml'
    identifier='02024R0001-20250101'
    raw=b'<html><head><title>technical.xml</title></head><body><p class="title-doc-first">REGULATION</p><p class="title-doc-last">Official complete subject</p><p>Article 1</p><p>Legal content</p><p class="oj-doc-ti">ANNEX I</p></body></html>'

    def responses(self):
        rows=[]
        for field,value in [('work_date_document','2024-01-03'),('official-journal-act_date_publication','2024-01-11')]:
            rows.append(dict(id={'value':self.identifier},p={'value':'http://publications.europa.eu/ontology/cdm#'+field},v={'value':value}))
        rows.append(dict(id={'value':'32000R9999'},p={'value':'http://publications.europa.eu/ontology/cdm#work_date_document'},v={'value':'1999-01-01'}))
        return [('CELLAR-SPARQL',json.dumps({'results':{'bindings':rows}}).encode())]

    def test_titles_are_taken_from_the_initial_block_in_all_four_languages(self):
        for title in ['REGULATION','ROZPORZĄDZENIE','VERORDENING','RÈGLEMENT']:
            raw=self.raw.decode().replace('REGULATION',title).encode()
            result=source_title(raw,self.url,self.identifier)
            self.assertEqual(result['value'],title+' Official complete subject')
            self.assertEqual(result['provenance']['kind'],'xhtml-title-block')
        for toc in ['Table of Contents','Spis treści','Inhoudsopgave','Table des matières']:
            raw=self.raw.decode().replace('<p>Article 1</p>','<p class="coj-sum-title-1">'+toc+'</p><p>Article 1</p>').encode()
            self.assertEqual(source_title(raw,self.url,self.identifier)['value'],'REGULATION Official complete subject')

    def test_legacy_page_separates_its_official_title_from_publication_citation(self):
        raw=('<title>technical.xml</title><h1>'+self.identifier+'</h1><p><strong>Original full title</strong><em>Journal citation</em></p>').encode()
        self.assertEqual(source_title(raw,self.url,self.identifier)['value'],'Original full title')

    def test_only_matching_official_date_fields_are_used_and_a_layer_is_not_adoption(self):
        header=expected_header(self.raw,self.url,self.identifier,self.responses())
        self.assertEqual(header['dates']['document']['value'],'2024-01-03')
        self.assertEqual(header['dates']['consolidation']['value'],'2025-01-01')
        self.assertEqual(header['dates']['publication']['value'],'2024-01-11')
        self.assertIsNone(expected_header(self.raw,self.url,self.identifier,[])['dates']['document']['value'])

    def test_forged_generated_or_manifest_headers_cannot_override_the_official_sources(self):
        header=expected_header(self.raw,self.url,self.identifier,self.responses())
        text='# REGULATION Official complete subject\n\nData dokumentu (work_date_document): 2024-01-03\nData konsolidacji (CELEX): 2025-01-01\nData publikacji (metadane publikacji): 2024-01-11\n\n<!-- legal-structure-v1 body -->\nOriginal legal body\n'
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);file=root/'law.md';document=dict(celex=self.identifier,header=header);files=[{'name':file.name}]
            file.write_text(text)
            verify_header(root,document,self.raw,self.url,self.responses(),files)
            for before,after in [('REGULATION Official complete subject','Forged title'),('2024-01-03','2024-01-04')]:
                file.write_text(text.replace(before,after))
                with self.assertRaises(AssertionError):verify_header(root,document,self.raw,self.url,self.responses(),files)
            forged=copy.deepcopy(document);forged['header']['dates']['document']['value']='2024-01-04'
            with self.assertRaisesRegex(AssertionError,'metadata differs'):verify_header(root,forged,self.raw,self.url,self.responses(),files)
