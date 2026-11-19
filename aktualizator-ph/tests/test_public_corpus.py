"""Publication lifecycle exercised against a local, isolated data ref."""
from datetime import date
from pathlib import Path
import hashlib
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import public_corpus as corpus
import public_github as public

FROM = '2025-01-01'
TO = '2026-11-19'
CODE = 'a' * 40
CONFIG = 'b' * 64


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(corpus.canonical(value))


def receipt(file, content):
    return {'name': file, 'size': len(content), 'md5': hashlib.md5(content).hexdigest(),
            'sha256': corpus.digest(content)}


def pair(app, date, label, proof):
    for module, directory in corpus.OUTPUTS.items():
        output = app / directory
        output.mkdir(parents=True, exist_ok=True)
        body = (label + ' official fixture\n').encode()
        source = corpus.canonical({'entries': [{'name': f'toestand/{label}.xml', 'kind': 'BWB-Toestand',
                                                'sha256': corpus.digest(body)}], 'range': {'observedOn': date}})
        (output / 'law.md').write_bytes(body)
        (output / '01_fixture.sources.json').write_bytes(source)
        act = {'files': [receipt('law.md', body)], 'sourceArchive': receipt('01_fixture.sources.json', source)}
        if module == 'NL':
            act.update(bwbId='BWBR0005290', sourceStates=[{'key': label, 'validFrom': FROM, 'validTo': None}])
        else:
            act.update(celex='32025D2591', documents=[
                {'celex': '32025D2591', 'language': 'EN', 'metadata': {'resource_legal_date_application': [FROM]},
                 'sourceSha256': corpus.digest(body), 'inputBodyHash': corpus.digest(body)}])
        dump(output / 'manifest.json', {'jurisdiction': 'NL' if module == 'NL' else 'EU', 'rangeFrom': FROM,
                                       'rangeTo': date, 'generatedAt': 'technical marker', 'acts': [act]})
        (output / 'INDEX.md').write_text('# Fixture\n')
        (output / 'REPORT.md').write_text('Technical report\n')
    files = {name: file for module, directory in corpus.OUTPUTS.items()
             for name, file in corpus.files_at(app / directory, module + '/').items()}
    dump(proof, {'audit': {'status': 'PASS', 'results': [
        {'jurisdiction': name, 'completeness': 'COMPLETE', 'range': [FROM, date]} for name in ('NL', 'EU')]},
        'files': corpus.hashes(files)})


class FileBasedPublicationTests(unittest.TestCase):
    def test_two_phase_publication_noop_and_failed_attempt_leave_one_valid_ref(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            app = root / 'app'
            state = app / '.public-state'
            control = app / '.public-control'
            remote = root / 'remote.git'
            public.git(root, 'init', '--quiet', '--bare', str(remote))
            dump(control / 'admission.json', {'accepted': True, 'sha': CODE})
            lease = Mock()
            lease.read.return_value = (CODE, {'status': 'RUNNING'})
            with patch.multiple(public, APP=app, STATE=state, CONTROL=control), \
                patch.object(public, 'data_remote', return_value=str(remote)), \
                patch.object(public, 'state_store', return_value=lease), \
                patch.object(public, 'configuration_digest', return_value=CONFIG), \
                patch.object(public, 'executable_digest', return_value=CONFIG), \
                patch.object(public, 'authenticated_environment', return_value=None):
                request = {'previousSha': '', 'revision': CODE, 'build': True, 'initialize': True,
                           'rangeTo': TO, 'executionSha256': CONFIG, 'configSha256': CONFIG}
                dump(state / 'request.json', request)
                pair(state / 'base', FROM, 'historical', state / 'base/verified.json')
                pair(app, TO, 'current', state / 'build/verified.json')
                # Failure after BASE must not create a data ref.
                (app / 'output-ue/law.md').write_text('Modified after audit')
                with self.assertRaisesRegex(ValueError, 'after validation'):
                    public.publish()
                self.assertEqual(public.git(remote, 'show-ref', acceptable=(0, 1)).returncode, 1)
                pair(app, TO, 'current', state / 'build/verified.json')
                public.publish()
                sha, previous = public.restore_previous(str(remote), state / 'prior')
                self.assertEqual(public.git(remote, 'rev-list', '--count', 'dane').stdout.strip(), b'1')
                self.assertEqual(previous['profile'], corpus.PROFILE)
                self.assertFalse(any(row['name'].endswith('.zip') for row in previous['files']))
                self.assertNotIn('generatedAt', (state / 'prior/NL/manifest.json').read_text())
                catalog = corpus.json_file(state / 'prior/NL/manifest.json')['acts'][0]['sourceArchive']
                self.assertNotIn('md5', catalog)
                self.assertTrue(corpus.verify_digests((state / 'prior/NL' / catalog['name']).read_bytes(), catalog))
                self.assertFalse(corpus.verify_digests(b'0' * catalog['size'], catalog))
                history = corpus.history_rows(state / 'prior/NL')[0]['files']
                self.assertIn('historical', (state / 'prior/NL' / history['law.md']['path']).read_text())
                request.update(previousSha=sha, initialize=False, priorDirectory='prior')
                dump(state / 'previous-publication.json', previous)
                dump(state / 'request.json', request)
                public.publish()
                self.assertIn(sha, (state / 'wait.md').read_text())
                self.assertEqual(public.git(remote, 'rev-parse', 'dane').stdout.decode().strip(), sha)

    def test_readme_only_data_branch_keeps_its_lease_for_bootstrap(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            remote = root / 'data.git'
            seed = root / 'seed'
            seed.mkdir()
            public.git(root, 'init', '--bare', '--quiet', str(remote))
            public.git(seed, 'init', '--quiet', '--initial-branch=dane')
            (seed / 'README.md').write_text('Empty corpus fixture\n')
            public.git(seed, 'add', 'README.md')
            public.git(seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                       'commit', '--quiet', '-m', 'Empty corpus')
            public.git(seed, 'push', '--quiet', str(remote), 'dane')
            previous_sha, snapshot = public.restore_previous(str(remote), root / 'restored')
            self.assertIsNone(snapshot)
            self.assertEqual(previous_sha, public.git(seed, 'rev-parse', 'HEAD').stdout.decode().strip())

    def test_transition_uses_legal_effects_not_technical_dates(self):
        facts = {'BWBR0002638/v1': {'dates': {'observedOn': '2026-11-19'},
                                   'effectDates': {'inwerkingtredingsdatum': ['2026-11-19']}},
                 'other': {'dates': {'work_date_document': ['2026-11-19']}}}
        self.assertEqual(corpus.dated_transitions(facts, date(2026, 11, 18), date(2026, 11, 19)), 1)
        self.assertEqual(corpus.dated_transitions(facts, date(2026, 11, 19), date(2026, 11, 20)), 0)

    def test_changed_integral_image_counts_even_when_text_and_date_are_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            paths = {name: root / name for name in ('old', 'new')}
            for name, folder in paths.items():
                dump(folder / 'manifest.json', {'acts': [], 'rangeTo': TO})
                dump(folder / 'IMAGE_INDEX.json', {'assets': [{'name': 'graphic.png', 'sha256': corpus.digest(name.encode())}],
                    'occurrences': [{'documentId': '32025D2591', 'version': '32025D2591', 'language': 'EN',
                                     'sourceLocator': '/p[1]/img[1]', 'kind': 'img', 'target': 'graphic.png'}]})
            self.assertEqual(corpus.compare({'UE': paths['old']}, {'UE': paths['new']}), {'UE': 1})

    def test_size_gate_is_per_module_and_allows_a_smaller_file(self):
        before = {'NL': 100, 'UE': 100}
        corpus.require_monotonic(before, {'NL': 101, 'UE': 100})
        for after, module in [({'NL': 99, 'UE': 1000}, 'NL'), ({'NL': 1000, 'UE': 99}, 'UE')]:
            with self.assertRaisesRegex(ValueError, f'shrank after merge: {module}'):
                corpus.require_monotonic(before, after)

    def test_large_catalog_externalizes_native_metadata_and_keeps_request_identity(self):
        catalog = {'entries': [{'name': 'original.xml', 'kind': 'BWB-WTI',
                                'metadata': {'wtiHistory': {'events': ['official value' * 100]}}}],
                   'unitHistory': {'sources': ['original.xml']}}
        with tempfile.TemporaryDirectory() as temp, patch.object(corpus, 'EVIDENCE_SPLIT', 100):
            target = Path(temp)
            save = lambda name, body: corpus.install_evidence(target, name, body)
            data = corpus.public_catalog(catalog, save)
            (target / '01_fixture.sources.json').write_bytes(data)
            restored = corpus.read_catalog(target, {'sourceArchive': {'name': '01_fixture.sources.json'}})
            self.assertEqual(restored['entries'][0]['metadata'], catalog['entries'][0]['metadata'])
            ref = restored['unitHistoryRefs']['sources']
            self.assertEqual(corpus.read_evidence(target, ref), corpus.canonical(['original.xml']))
            (target / ref['name']).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                corpus.read_evidence(target, ref)

    def test_history_is_validated_even_after_outer_hashes_are_recalculated(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / 'NL').mkdir()
            dump(directory / 'NL/history.json', {'snapshots': [
                {'id': 'a' * 64, 'files': {'manifest.json': {'path': 'manifest.json', 'sha256': 'b' * 64}}}]})
            dump(directory / 'NL/manifest.json', {'acts': []})
            rows = corpus.hashes(corpus.files_at(directory))
            with self.assertRaisesRegex(ValueError, 'History references'):
                corpus.check_history(directory, rows)


if __name__ == '__main__':
    unittest.main()
