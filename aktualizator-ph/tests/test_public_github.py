"""Shared GitHub output: snapshots, request isolation, history and cleanup."""
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'scripts'))
spec = importlib.util.spec_from_file_location('public_github', APP / 'scripts/public_github.py')
public = importlib.util.module_from_spec(spec)
spec.loader.exec_module(public)
NOW = datetime(2026, 11, 13, 12, tzinfo=timezone.utc)
REVISION = 'a' * 40
CONFIG = 'b' * 64


def fixture(root, extra='current.md'):
    root.mkdir()
    (root / '.public-state').mkdir()
    (root / '.public-state/independent-audit.json').write_text(json.dumps({'status': 'PASS'}))
    rows = []
    for module, directory in [('NL', 'output'), ('UE', 'output-ue')]:
        target = root / directory
        target.mkdir()
        files = {'manifest.json': json.dumps({'jurisdiction': 'EU' if module == 'UE' else 'NL',
            'rangeFrom': '2025-01-01', 'rangeTo': '2026-11-13', 'acts': [{'order': 1}]}),
            'INDEX.md': 'Index\n', 'REPORT.md': 'PASS\n', extra: 'Official source fixture\n'}
        for name, text in files.items():
            blob = text.encode()
            (target / name).write_bytes(blob)
            rows.append({'name': module + '/' + name, 'bytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()})
    (root / '.public-state/validated-files.json').write_text(json.dumps(rows))
    return root


class PublicGitHubTests(unittest.TestCase):
    def test_release_packages_use_release_asset_limit_instead_of_ordinary_git_file_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);files=[]
            for name in ['NL-results.zip','UE-results.zip','NL-sources.zip','UE-sources.zip']:
                raw=b'package bytes';(root/name).write_bytes(raw)
                files.append(dict(name=name,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()))
            (root/'distribution.json').write_text(json.dumps(dict(profile='public-distribution-v1',status='PASS',counts={'NL':1,'UE':1},files=files)))
            with patch.object(public,'MAX_FILE',1):self.assertEqual(public.validate_distribution(root)['status'],'PASS')

    def test_snapshot_has_one_complete_pair_and_detects_modified_or_extra_bytes(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            app = fixture(root / 'app')
            value = public.create_snapshot(app, root / 'snapshot', REVISION, CONFIG, NOW)
            self.assertEqual(value['counts'], {'NL': 1, 'UE': 1})
            self.assertEqual(public.validate_snapshot(root / 'snapshot'), value)
            (root / 'snapshot/NL/current.md').write_text('Changed after publication')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                public.validate_snapshot(root / 'snapshot')
            (app / 'output/extra.md').write_text('Unvalidated file')
            with self.assertRaisesRegex(ValueError, 'after validation'):
                public.create_snapshot(app, root / 'extra', REVISION, CONFIG, NOW)

    def test_pair_failure_or_missing_module_never_becomes_publishable(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            app = fixture(root / 'app')
            manifest = app / 'output-ue/manifest.json'
            value = json.loads(manifest.read_bytes())
            value['rangeTo'] = '2026-11-12'
            manifest.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                public.create_snapshot(app, root / 'bad', REVISION, CONFIG, NOW)
            (app / '.public-state/independent-audit.json').write_text('{"status":"FAIL"}')
            with self.assertRaises(ValueError):
                public.create_snapshot(app, root / 'bad-again', REVISION, CONFIG, NOW)

    def test_public_request_ignores_arbitrary_body_and_disallows_other_events_and_branches(self):
        event = {'action': 'opened', 'issue': {'number': 5, 'title': public.REQUEST_TITLE,
                  'body': '$(touch /tmp/UNSAFE); --config-dir=/private'}}
        self.assertTrue(public.trusted_event('issues', event, 'refs/heads/main'))
        self.assertTrue(public.trusted_event('workflow_dispatch', {}, 'refs/heads/main'))
        for event_name, ref in [('issues', 'refs/heads/fork'), ('pull_request', 'refs/heads/main'),
                                ('pull_request_target', 'refs/heads/main'), ('schedule', 'refs/heads/main')]:
            self.assertFalse(public.trusted_event(event_name, event, ref))
        event['issue']['title'] += '; shell injection'
        self.assertFalse(public.trusted_event('issues', event, 'refs/heads/main'))

    def test_cooldown_never_hides_new_code_config_or_calendar_day(self):
        current = {'codeRevision': REVISION, 'configurationSha256': CONFIG,
                   'publishedAt': NOW.isoformat(), 'rangeTo': '2026-11-13'}
        self.assertTrue(public.fresh(current, REVISION, CONFIG, NOW + timedelta(minutes=5)))
        self.assertFalse(public.fresh(current, REVISION, CONFIG, NOW + timedelta(hours=2)))
        self.assertFalse(public.fresh(current, 'c' * 40, CONFIG, NOW))
        self.assertFalse(public.fresh(current, REVISION, 'd' * 64, NOW))
        self.assertFalse(public.fresh(current, REVISION, CONFIG, NOW, force=True))
        self.assertFalse(public.fresh(current, REVISION, CONFIG, NOW - timedelta(seconds=1)))

    def test_atomic_replacement_removes_old_files_and_history_and_preserves_code_and_concurrent_data(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            remote = root / 'remote.git'
            subprocess.run(['git', 'init', '--quiet', '--bare', str(remote)], check=True)
            code = root / 'code'
            code.mkdir()
            public.git(code, 'init', '--quiet', '--initial-branch=main')
            public.git(code, 'config', 'user.name', 'Fixture')
            public.git(code, 'config', 'user.email', 'fixture@example.invalid')
            (code / 'README.md').write_text('Protected code fixture')
            public.git(code, 'add', '.')
            public.git(code, 'commit', '--quiet', '-m', 'Initial code')
            code_sha = public.git(code, 'rev-parse', 'HEAD').stdout.decode().strip()
            public.git(code, 'push', '--quiet', str(remote), 'main')
            first = root / 'first'
            public.create_snapshot(fixture(root / 'app-one', 'obsolete.md'), first, REVISION, CONFIG, NOW)
            old = public.push_snapshot(first, '', str(remote))
            restored_sha, restored = public.restore_previous(str(remote), root / 'restored')
            self.assertEqual(restored_sha, old)
            self.assertEqual(restored['status'], 'PASS')
            second = root / 'second'
            public.create_snapshot(fixture(root / 'app-two'), second, REVISION, CONFIG, NOW + timedelta(hours=2))
            current = public.push_snapshot(second, old, str(remote))
            self.assertNotEqual(current, old)
            self.assertEqual(public.git(remote, 'rev-list', '--count', 'dane').stdout.strip(), b'1')
            self.assertEqual(public.git(remote, 'rev-parse', 'main').stdout.decode().strip(), code_sha)
            names = public.git(remote, 'ls-tree', '-r', '--name-only', 'dane').stdout.decode().splitlines()
            self.assertIn('NL/current.md', names)
            self.assertNotIn('NL/obsolete.md', names)
            third = root / 'third'
            public.create_snapshot(fixture(root / 'app-three'), third, REVISION, CONFIG, NOW + timedelta(hours=3))
            with self.assertRaises(RuntimeError):
                public.push_snapshot(third, old, str(remote))
            self.assertEqual(public.git(remote, 'rev-parse', 'dane').stdout.decode().strip(), current)

    def test_cleanup_preserves_cache_checkpoints_and_outputs_but_removes_run_scratch(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            app = fixture(root / 'app')
            outside = root / 'outside'
            outside.mkdir()
            (outside / 'keep').write_text('must survive')
            (app / '.public-control').symlink_to(outside, target_is_directory=True)
            for directory in ('.source-cache', '.checkpoint', '.checkpoint-ue'):
                (app / directory).mkdir()
                (app / directory / 'keep').write_text('required for next run')
            (app / '.public-state').mkdir(exist_ok=True)
            (app / '.public-state' / 'scratch').write_text('temporary')
            (app / 'source.ts').write_text('code survives')
            with patch.object(public, 'APP', app):
                public.cleanup()
            self.assertFalse((app / '.public-state').exists())
            self.assertTrue((app / 'output').exists())
            self.assertTrue((app / 'output-ue').exists())
            self.assertFalse((app / '.public-control').exists())
            for directory in ('.source-cache', '.checkpoint', '.checkpoint-ue'):
                self.assertEqual((app / directory / 'keep').read_text(), 'required for next run')
            self.assertTrue((outside / 'keep').exists())
            self.assertTrue((app / 'source.ts').exists())

    def test_workflow_uses_trusted_code_no_user_secret_no_scheduled_trigger_and_always_cleans_up(self):
        text = (APP.parent / '.github/workflows/public-corpus.yml').read_text()
        workflow = yaml.safe_load(text)
        events = workflow.get('on', workflow.get(True))
        self.assertEqual(set(events), {'workflow_dispatch', 'issues'})
        self.assertNotIn('secrets.', text)
        self.assertNotIn('pull_request_target', text)
        self.assertNotIn('github.event.issue.body', text)
        self.assertNotIn('concurrency', workflow)
        job = workflow['jobs']['publish']
        self.assertIn("github.ref == 'refs/heads/main'", job['if'])
        cleanup = job['steps'][-1]
        self.assertIn('always()', cleanup['if'])
        self.assertEqual(cleanup['run'], 'python3 scripts/public_github.py cleanup')
        build = next(s for s in job['steps'] if s.get('name') == 'Build and independently verify the complete public corpus')
        self.assertNotIn('GH_TOKEN', build.get('env', {}))
        for step in job['steps']:
            self.assertNotIn('upload-artifact', step.get('uses', ''))
            if 'uses' in step:
                self.assertRegex(step['uses'], r'@[a-f0-9]{40}$')


if __name__ == '__main__':
    unittest.main()
