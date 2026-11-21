"""Cache signatures remain deterministic; eviction is left to GitHub Actions."""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('public_cache', Path(__file__).resolve().parents[1] / 'scripts/public_cache.py')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class CacheSignatureTests(unittest.TestCase):
    def test_signatures_are_stable_and_track_file_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / 'http' / '0'
            directory.mkdir(parents=True)
            sample = directory / 'source.txt'
            sample.write_text('old', encoding='utf-8')
            original = cache.cache_signature(root, '0')
            self.assertEqual(original, cache.cache_signature(root, '0'))
            sample.write_text('new', encoding='utf-8')
            self.assertNotEqual(original, cache.cache_signature(root, '0'))

    def test_pruning_api_is_not_available(self):
        self.assertFalse(hasattr(cache, 'prune_local'))
        self.assertFalse(hasattr(cache, 'prune_remote'))

    def test_pruning_commands_are_rejected(self):
        for command in ('local', 'remote'):
            with self.subTest(command=command):
                with mock.patch.object(sys, 'argv', ['public_cache.py', command]):
                    with contextlib.redirect_stderr(io.StringIO()):
                        with self.assertRaises(SystemExit) as error:
                            cache.main()
                self.assertEqual(error.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
