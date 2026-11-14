import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('public_cache', Path(__file__).resolve().parents[1] / 'scripts/public_cache.py')
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class CachePolicyTests(unittest.TestCase):
    def test_crossing_high_water_reaches_low_water_not_just_high_water(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for number in range(4):
                (root / str(number)).write_bytes(b'a' * 20)
            result = cache.prune_local(root, high=70, low=40)
            self.assertEqual(result['beforeBytes'], 80)
            self.assertLessEqual(result['afterBytes'], 40)
            self.assertGreaterEqual(result['removedBytes'], 40)

    def test_exact_high_water_preserves_every_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'one').write_bytes(b'x'*70)
            self.assertEqual(cache.prune_local(root, high=70, low=40)['deleted'], [])

    def test_remote_retention_touches_only_owned_cache_entries(self):
        class API:
            def __init__(self): self.deleted = []
            def request(self, route, **options):
                if options.get('method') == 'DELETE':
                    self.deleted.append(int(route.rsplit('/', 1)[-1]));return None
                return {'actions_caches': [
                    dict(id=1,key='foreign',size_in_bytes=1000,created_at='2020'),
                    dict(id=2,key=cache.PREFIX+'old',size_in_bytes=45,created_at='2021'),
                    dict(id=3,key=cache.PREFIX+'new',size_in_bytes=35,created_at='2022')]}
        api = API();result = cache.prune_remote(api, high=70, low=40)
        self.assertEqual(api.deleted, [2]);self.assertEqual(result['afterBytes'], 35)


if __name__ == '__main__': unittest.main()
