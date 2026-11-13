import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from evidence_bundle import pack, unpack

class EvidenceBundles(unittest.TestCase):
    def test_missing_required_input_fails_and_explicit_partial_layout_is_stable(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);nl=root/'NL';nl.mkdir();(nl/'manifest.json').write_text('{}')
            with self.assertRaises(ValueError):pack(root/'required.zip',[nl,root/'EU'])
            report=pack(root/'partial.zip',[nl,root/'EU'],allow_missing=True)
            self.assertTrue(report['partial']);self.assertEqual(report['missing'],['EU'])
            unpack(root/'partial.zip',root/'restored')
            self.assertTrue((root/'restored/NL/manifest.json').exists())

    def test_identical_bytes_produce_identical_archives_despite_changed_filesystem_time(self):
        import os
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);f=root/'payload';f.write_bytes(b'unchanged')
            pack(root/'one.zip',[f]);os.utime(f,(1700000000,1700000000));pack(root/'two.zip',[f])
            self.assertEqual((root/'one.zip').read_bytes(),(root/'two.zip').read_bytes())

    def test_hidden_fixture_and_multiroot_layout_survive(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);fixture=root/'fixture';fixture.mkdir()
            (fixture/'.cache').write_bytes(b'original cache')
            archive=root/'archive.zip';pack(archive,[fixture])
            unpack(archive,root/'restored')
            self.assertEqual((root/'restored/.cache').read_bytes(),b'original cache')
            other=root/'log.txt';other.write_text('receipt')
            pack(root/'multi.zip',[fixture,other]);unpack(root/'multi.zip',root/'multi')
            self.assertEqual((root/'multi/fixture/.cache').read_bytes(),b'original cache')
            with self.assertRaises(ValueError):unpack(archive,root/'restored')

    def test_symlink_input_and_empty_input_are_rejected(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);file=root/'file';file.write_text('evidence')
            link=root/'link';link.symlink_to(file)
            with self.assertRaises(ValueError):pack(root/'bad.zip',[link])
            with self.assertRaises(ValueError):pack(root/'empty.zip',[])
