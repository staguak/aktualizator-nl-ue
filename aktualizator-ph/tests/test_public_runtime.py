"""Audit requests, stable fingerprints, safe diagnostics and resilient notifications."""
from datetime import datetime, timedelta, timezone
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
from zoneinfo import ZoneInfo

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'scripts'))
import public_github as public
from public_support import GitHubApi, PublicError, executable_digest, git, record_diagnostic

REV = 'a' * 40
CONFIG = 'b' * 64
EXEC = 'c' * 64


class NotificationApi:
    def __init__(self):
        self.comments = []
        self.posts = 0
        self.waits = []
        self.closed = False

    def wait(self, seconds):
        self.waits.append(seconds)

    def request(self, route, payload=None, method='GET', attempts=3):
        if method == 'GET':
            return self.comments
        if method == 'POST':
            self.posts += 1
            self.comments.append({'id': 77, 'body': payload['body'], 'user': {'login': 'github-actions[bot]'}})
            if self.posts == 1:
                raise PublicError('GITHUB_HTTP_503', 'GITHUB_API', 503)
            return self.comments[-1]
        if route.startswith('/issues/comments/'):
            self.comments[0]['body'] = payload['body']
        else:
            self.closed = payload['state'] == 'closed'
        return {}


class RuntimeTests(unittest.TestCase):
    def test_full_audit_alone_bypasses_freshness_and_sets_unconditional_mode(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            event = root / 'event.json'
            event.write_text(json.dumps({'inputs': {'force': False, 'full_source_audit': True}}))
            now = datetime.now(timezone.utc)
            previous = {'codeRevision': REV, 'configurationSha256': CONFIG, 'executionSha256': EXEC,
                        'publishedAt': now.isoformat(), 'rangeTo': now.astimezone(ZoneInfo('Europe/Warsaw')).date().isoformat()}
            control = root / '.public-control'
            control.mkdir()
            (control / 'admission.json').write_text('{"accepted":true}')
            def restore(remote, target):
                for module in ('NL', 'UE'):
                    (target / module).mkdir(parents=True)
                return 'd' * 40, previous
            env = {'GITHUB_EVENT_PATH': str(event), 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
                   'GITHUB_SHA': REV, 'GITHUB_REPOSITORY': 'example/updater', 'INPUT_FORCE': 'false', 'INPUT_FULL_SOURCE_AUDIT': 'true'}
            with patch.object(public, 'APP', root), patch.object(public, 'STATE', root / '.public-state'), patch.object(public, 'CONTROL', control),\
                 patch.object(public, 'configuration_digest', return_value=CONFIG), patch.object(public, 'executable_digest', return_value=EXEC),\
                 patch.object(public, 'restore_previous', side_effect=restore),\
                 patch.object(public, 'git', return_value=subprocess.CompletedProcess([], 0, stdout=(REV + '\n').encode())), patch.dict(os.environ, env):
                public.prepare()
            request = json.loads((root / '.public-state/request.json').read_bytes())
            self.assertTrue(request['build'])
            self.assertEqual(request['sourceAudit'], 'unconditional')

    def test_same_executable_tree_ignores_commit_metadata_but_code_or_config_changes_expire(self):
        now = datetime.now(timezone.utc)
        current = {'codeRevision': REV, 'configurationSha256': CONFIG, 'executionSha256': EXEC,
                   'publishedAt': now.isoformat(), 'rangeTo': now.astimezone(ZoneInfo('Europe/Warsaw')).date().isoformat()}
        self.assertTrue(public.fresh(current, 'd' * 40, CONFIG, now, execution=EXEC))
        self.assertFalse(public.fresh(current, 'd' * 40, CONFIG, now, execution='e' * 64))
        self.assertFalse(public.fresh(current, REV, 'e' * 64, now, execution=EXEC))
        self.assertFalse(public.fresh(current, REV, CONFIG, now, force=True, execution=EXEC))

    def test_execution_fingerprint_ignores_docs_tests_and_commit_identity(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            git(root, 'init', '--quiet')
            for file in ('package.json', 'package-lock.json', '.node-version', 'src/parser.ts', 'scripts/validator.py'):
                p = root / file
                p.parent.mkdir(exist_ok=True)
                p.write_text('initial')
            git(root, 'add', '.')
            initial = executable_digest(root)
            (root / 'README.md').write_text('Documentation only')
            (root / 'src/parser.test.ts').write_text('Test only')
            git(root, 'add', '.')
            self.assertEqual(executable_digest(root), initial)
            (root / 'scripts/validator.py').write_text('A real semantic change')
            self.assertNotEqual(executable_digest(root), initial)

    def test_lost_comment_reply_is_reconciled_without_duplicate_comment(self):
        api = NotificationApi()
        marker = '<!-- public-corpus-result:101:1 -->'
        public.notify(api, 1, marker + '\nPUBLISHED', marker)
        public.notify(api, 1, marker + '\nPUBLISHED', marker)
        self.assertEqual(api.posts, 1)
        self.assertEqual(len(api.comments), 1)

    def test_preflight_failure_gets_an_issue_response_and_notification_failure_preserves_publication(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            event = root / 'event.json'
            event.write_text(json.dumps({'action': 'opened', 'issue': {'number': 1, 'title': public.REQUEST_TITLE}}))
            env = {'GITHUB_EVENT_PATH': str(event), 'GITHUB_EVENT_NAME': 'issues', 'GITHUB_REF': 'refs/heads/main',
                   'GITHUB_REPOSITORY': 'example/updater', 'GITHUB_RUN_ID': '101', 'GITHUB_RUN_ATTEMPT': '1', 'GH_TOKEN': 'SYNTHETIC'}
            result = {'status': 'FAILED', 'error': {'code': 'GIT_TRANSPORT_FAILED', 'stage': 'RESTORE_PREVIOUS'}}
            (root / 'result.json').write_text(json.dumps(result))
            api = NotificationApi()
            with patch.object(public, 'CONTROL', root), patch.dict(os.environ, env), patch.object(public, 'GitHubApi', return_value=api):
                public.finish_request()
            self.assertIn('GIT_TRANSPORT_FAILED', api.comments[0]['body'])
            self.assertFalse(api.closed)
            (root / 'result.json').write_text('{"status":"PUBLISHED"}')
            with patch.object(public, 'CONTROL', root), patch.dict(os.environ, env),\
                 patch.object(public, 'finish_request', side_effect=PublicError('GITHUB_HTTP_503', 'GITHUB_API', 503)),\
                 patch.object(sys, 'argv', ['public_github.py', 'finish-request']), redirect_stdout(io.StringIO()):
                self.assertEqual(public.main(), 0)
            self.assertEqual(json.loads((root / 'result.json').read_bytes())['status'], 'PUBLISHED')
            self.assertIn('GITHUB_HTTP_503', (root / 'warnings.jsonl').read_text())

    def test_safe_diagnostics_distinguish_causes_without_sdk_or_input_contents(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            captured = io.StringIO()
            with redirect_stdout(captured):
                first = record_diagnostic(root, PublicError('DATA_REF_CONFLICT', 'PUSH_DATA'), 'PUBLISH')
                second = record_diagnostic(root, json.JSONDecodeError('PRIVATE_TOKEN', 'PRIVATE_INPUT', 0), 'READ_EVENT')
            self.assertNotEqual(first['code'], second['code'])
            saved = (root / 'errors.jsonl').read_text()
            self.assertNotIn('PRIVATE_', saved)
            self.assertNotIn('PRIVATE_', captured.getvalue())
            self.assertIn('READ_EVENT', saved)

    def test_api_retries_only_transient_failures_and_never_echoes_response_body(self):
        replies = [urllib.error.HTTPError('https://api.github.com', 503, 'PRIVATE_TOKEN', {}, None),
                   urllib.error.HTTPError('https://api.github.com', 429, 'PRIVATE_TOKEN', {'Retry-After': '0'}, None),
                   io.BytesIO(b'{"status":"ready"}')]
        waits = []
        def open_request(request, timeout):
            value = replies.pop(0)
            if isinstance(value, Exception):
                raise value
            return value
        api = GitHubApi('example/updater', 'SYNTHETIC', opener=open_request, wait=waits.append)
        self.assertEqual(api.request('/actions/runs/1'), {'status': 'ready'})
        self.assertEqual(len(waits), 2)
        denied = GitHubApi('example/updater', 'SYNTHETIC',
                           opener=lambda *a, **kw: (_ for _ in ()).throw(urllib.error.HTTPError('https://api.github.com', 403, 'PRIVATE_TOKEN', {}, None)), wait=waits.append)
        with self.assertRaises(PublicError) as error:
            denied.request('/actions/runs/1')
        self.assertEqual(error.exception.code, 'GITHUB_HTTP_403')
        self.assertNotIn('PRIVATE_TOKEN', str(error.exception))


if __name__ == '__main__':
    unittest.main()
