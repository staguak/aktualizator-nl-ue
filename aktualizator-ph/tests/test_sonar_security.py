"""Regression tests for reviewed SonarCloud security and CSS findings."""
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from build_source_zip import build
from public_support import GitHubApi, PublicError
from verify_inline_images import URL

LEGACY = re.compile(r'''url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)''', re.I)


class ScannerTests(unittest.TestCase):
    def test_css_substitution_matches_original(self):
        examples = [
            'background:url(img.png)', 'url("quoted path.svg")',
            "a{background:url('x y')} url( )", 'url(url(a)',
            'unmatched url("broken text) url(working)',
            'url(\u0130) url(a)', 'url(a\t)', 'URL(a)URL(b)'
        ]
        def replacement(match):
            uri = next(group for group in match.groups() if group is not None)
            return '[' + uri + ':' + str(match.start()) + ']'
        for example in examples:
            with self.subTest(example=example):
                self.assertEqual(URL.sub(replacement, example), LEGACY.sub(replacement, example))

    def test_long_nested_tokens(self):
        data = 'url('.join([''] * 10000) + ' url(valid.png)'
        self.assertEqual(URL.sub(lambda match: '[OK]', data).count('[OK]'), 1)


class ZipSafetyTests(unittest.TestCase):
    def recipe(self, directory, source):
        catalog = directory / 'manifest.json'
        catalog.write_bytes(b'{"profile":"test"}')
        return {
            'target': str(directory / 'source.zip'), 'catalog': str(catalog),
            'catalogSize': catalog.stat().st_size,
            'catalogSha256': hashlib.sha256(catalog.read_bytes()).hexdigest(),
            'files': [{'name': 'source/data.xml', 'path': str(source),
                       'size': source.stat().st_size,
                       'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}],
        }

    def test_safe_original_bytes_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            original = directory / 'original.xml'
            original.write_bytes(b'<root>\x00original</root>')
            recipe_path = directory / 'recipe.json'
            build(self.recipe(directory, original), recipe_path)
            with zipfile.ZipFile(directory / 'source.zip') as result:
                self.assertEqual(result.read('source/data.xml'), original.read_bytes())
                self.assertEqual(result.read('manifest.json'), b'{"profile":"test"}')

    def test_symlink_and_checksum_changes_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            original = directory / 'original.xml'
            original.write_bytes(b'<root>original</root>')
            link = directory / 'link.xml'
            link.symlink_to(original)
            recipe_path = directory / 'recipe.json'
            with self.assertRaises(ValueError):
                build(self.recipe(directory, link), recipe_path)
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            original = directory / 'original.xml'
            original.write_bytes(b'<root>original</root>')
            recipe = self.recipe(directory, original)
            recipe['files'][0]['sha256'] = '0' * 64
            with self.assertRaises(ValueError):
                build(recipe, directory / 'recipe.json')


class ApiRouteTests(unittest.TestCase):
    def test_whitelisted_api_routes_and_methods_only(self):
        calls = []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): return None
            def read(self, *_): return b'{"ok":true}'
        def opener(request, timeout):
            calls.append((request.full_url, request.get_method()))
            return Response()
        api = GitHubApi('valid/repo', 'fake-token', opener=opener)
        allowed = [
            ('/issues/123/comments?per_page=100&page=1', 'GET'),
            ('/issues/123/comments', 'POST'),
            ('/issues/123', 'PATCH'),
            ('/issues/comments/12345', 'PATCH'),
            ('/actions/runs/12345/attempts/2', 'GET'),
        ]
        for suffix, method in allowed:
            self.assertEqual(api.request(suffix, method=method), {'ok': True})
        self.assertEqual(len(calls), len(allowed))
        for suffix, method in [
            ('/issues/123/../actions/runs/1', 'GET'),
            ('/issues/%2e%2e/comments', 'POST'),
            ('//issues/123', 'PATCH'),
            ('/issues/123/comments?per_page=100&page=9999', 'GET'),
            ('/issues/123/comments?per_page=100&page=1&admin=1', 'GET'),
            ('/issues/123/comments', 'DELETE'),
            ('/actions/runs/123/attempts/2%2f..', 'GET'),
        ]:
            with self.subTest(suffix=suffix, method=method):
                with self.assertRaises(PublicError):
                    api.request(suffix, method=method)
        self.assertEqual(len(calls), len(allowed))


if __name__ == '__main__':
    unittest.main()
