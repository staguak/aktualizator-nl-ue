"""Regression checks for untrusted Formex source locators and documentary dates."""
import sys
from pathlib import Path
import unittest
from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from verify_formex_package import resolve_formex_locator
from verify_eu_headers import documentary_date

class FormexLocatorSecurity(unittest.TestCase):
    def setUp(self):
        self.root = etree.fromstring(
            b'<ACT><BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>'
            b'<ARTICLE><PARAG>One</PARAG><PARAG>Two</PARAG></ARTICLE>'
            b'<INCL.ELEMENT FILEREF="annex.xml"/></ACT>'
        )

    def test_canonical_element_and_attribute_locators(self):
        self.assertEqual(resolve_formex_locator(self.root, '/ACT[1]/ARTICLE[1]/PARAG[2]'), [self.root[1][1]])
        self.assertEqual(resolve_formex_locator(self.root, '/ACT/ARTICLE/PARAG[1]'), [self.root[1][0]])
        self.assertEqual(resolve_formex_locator(self.root, '/ACT[1]/INCL.ELEMENT[1]/@FILEREF'), ['annex.xml'])
        self.assertEqual(resolve_formex_locator(self.root, '/ACT[1]/INCL.ELEMENT[1]/@MISSING'), [])

    def test_untrusted_xpaths_cannot_run_expressions(self):
        attacks = [
            '/ACT[1]/ARTICLE[1] | /ACT[1]/ARTICLE[1]',
            '/ACT[1]/ARTICLE[1][true()]',
            '/ACT[1]/ARTICLE[1][count(//*) > 0]',
            '/ACT[1]//ARTICLE',
            '/ACT[1]/ARTICLE[1]/..',
            '/ACT[1]/ARTICLE[1]/@FILEREF or true()',
            '/ACT[1]/ARTICLE[1]/PARAG[0]',
            '/ACT[1]/ARTICLE[1]/PARAG[999999999999999999999999]',
        ]
        for attack in attacks:
            with self.subTest(attack=attack), self.assertRaises(ValueError):
                resolve_formex_locator(self.root, attack)

    def test_unindexed_duplicate_nodes_are_rejected(self):
        with self.assertRaises(ValueError):
            resolve_formex_locator(self.root, '/ACT/ARTICLE/PARAG')

class DocumentaryDates(unittest.TestCase):
    def test_valid_calendar_date(self):
        self.assertEqual(documentary_date({'work_date_document': ['2026-11-16']})['status'], 'confirmed')

    def test_invalid_calendar_date_is_not_confirmed(self):
        for value in ('2026-13-01', '2026-02-30', '2026-11-16junk', ''):
            with self.subTest(value=value):
                result = documentary_date({'work_date_document': [value]})
                self.assertEqual(result['status'], 'invalid')
                self.assertIsNone(result['value'])

if __name__ == '__main__':
    unittest.main()
