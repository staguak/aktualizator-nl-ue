"""Regression tests: run-specific Sonar/Git reports, no guessed or stale results."""
import base64
import json
import os
import tempfile
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from export_run_reports import GitHub, ExportError, export, sonar_api_snapshot, sonar_selector, fetch_json, main

REPO = 'staguak/aktualizator-nl-ue'
SHA = 'a' * 40


class ReportExportTests(unittest.TestCase):
    def test_sonar_check_is_exported_with_original_summary_and_annotations(self):
        def getter(url, token=None):
            if url.endswith('/check-runs/81'):
                return dict(id=81, name='SonarCloud Code Analysis', head_sha=SHA,
                            status='completed', conclusion='failure', app=dict(slug='sonarqubecloud'),
                            details_url='https://sonarcloud.io/dashboard?id=staguak_aktualizator-nl-ue&branch=main',
                            output=dict(title='Quality Gate failed', summary='2 new issues',
                                        annotations_count=1))
            if url.endswith('/check-runs/81/annotations?per_page=100&page=1'):
                return [{'path': 'main.ts', 'message': 'Review this condition'}]
            raise AssertionError(url)
        gh = GitHub(REPO, 'dummy', getter)
        event = dict(repository=dict(full_name=REPO), check_run=dict(id=81, app=dict(slug='sonarqubecloud')))
        report = export('check_run', event, gh, sonar_getter=lambda url: {'issues': [], 'paging': {'total': 0}})
        self.assertEqual(report['check']['output']['summary'], '2 new issues')
        self.assertEqual(report['check']['conclusion'], 'failure')
        self.assertTrue(report['check']['annotationsComplete'])
        self.assertEqual(report['check']['annotations'][0]['path'], 'main.ts')
        self.assertEqual(report['type'], 'sonarqube-cloud')
        self.assertEqual(report['sonarApi']['selector'], {'branch': 'main'})

    def test_failed_workflow_still_exports_git_and_job_status(self):
        def getter(url, token=None):
            if url.endswith('/actions/runs/55'):
                return dict(id=55, name='Verify public updater code', head_sha=SHA,
                            conclusion='failure', status='completed')
            if '/actions/runs/55/jobs?' in url:
                return {'jobs': [dict(id=1, name='test', conclusion='failure', steps=[dict(name='Unit tests', conclusion='failure')])]}
            if url.endswith('/commits/' + SHA):
                return dict(sha=SHA, commit=dict(message='Fix parsing', author=dict(name='test')),
                            stats=dict(additions=4, deletions=2), files=[dict(filename='src/a.ts', additions=4)])
            if '/commits/' + SHA + '/check-runs?' in url:
                return {'check_runs': []}
            raise AssertionError(url)
        event = dict(repository=dict(full_name=REPO), workflow_run=dict(id=55))
        report = export('workflow_run', event, GitHub(REPO, 'dummy', getter))
        self.assertEqual(report['data']['workflow']['conclusion'], 'failure')
        self.assertEqual(report['data']['git']['stats']['additions'], 4)
        self.assertEqual(report['data']['jobs'][0]['conclusion'], 'failure')

    def test_workflow_collects_completed_sonar_report_without_sonar_event(self):
        def getter(url, token=None):
            if url.endswith('/actions/runs/55'):
                return dict(id=55, name='Verify public updater code', head_sha=SHA,
                            conclusion='success', status='completed')
            if '/actions/runs/55/jobs?' in url:
                return {'jobs': []}
            if url.endswith('/commits/' + SHA):
                return {'sha': SHA, 'commit': {'message': 'test', 'author': {'name': 'a'}}}
            if '/commits/' + SHA + '/check-runs?' in url:
                return {'check_runs': [dict(id=82, app={'slug': 'sonarqubecloud'}, status='completed')]}
            if url.endswith('/check-runs/82'):
                return dict(id=82, app={'slug': 'sonarqubecloud'}, status='completed',
                            name='SonarCloud Code Analysis', head_sha=SHA,
                            details_url='https://sonarcloud.io/dashboard?id=staguak_aktualizator-nl-ue&branch=main',
                            conclusion='success', output={'summary': 'Quality Gate passed', 'annotations_count': 0})
            raise AssertionError(url)
        event = dict(repository={'full_name': REPO}, workflow_run={'id': 55})
        with patch('export_run_reports.sonar_api_snapshot', return_value={'projectKey': REPO}):
            report = export('workflow_run', event, GitHub(REPO, 'dummy', getter))
        self.assertEqual(report['data']['sonarReports'][0]['check']['output']['summary'], 'Quality Gate passed')

    def test_non_sonar_check_refused(self):
        event = dict(repository=dict(full_name=REPO), check_run=dict(id=10, app=dict(slug='github-actions')))
        with self.assertRaisesRegex(ExportError, 'CHECK_NOT_SONAR'):
            export('check_run', event, GitHub(REPO, 'dummy', lambda *a: None))

    def test_repository_mismatch_refused(self):
        event = dict(repository=dict(full_name='someone/other'), workflow_run=dict(id=22))
        with self.assertRaisesRegex(ExportError, 'EVENT_REPOSITORY_MISMATCH'):
            export('workflow_run', event, GitHub(REPO, 'dummy', lambda *a: None))

    def test_sonar_api_failure_is_marked_not_assumed_success(self):
        def getter(url):
            raise ExportError('HTTP_403')
        result = sonar_api_snapshot(selector={'branch': 'main'}, getter=getter)
        self.assertEqual(result['qualityGateError'], 'HTTP_403')
        self.assertEqual(result['measuresError'], 'HTTP_403')
        self.assertFalse(result['issuesComplete'])
        self.assertEqual(result['issuesError'], 'HTTP_403')

    def test_sonar_issue_pagination_is_complete(self):
        def getter(url):
            if 'issues/search' in url:
                if 'p=1' in url:
                    return {'issues': [{'key': 'A'}, {'key': 'B'}], 'paging': {'total': 2}}
                raise AssertionError('Should have stopped')
            return {}
        result = sonar_api_snapshot(selector={'branch': 'main'}, getter=getter)
        self.assertTrue(result['issuesComplete'])
        self.assertEqual(len(result['issues']), 2)

    def test_sonar_pr_api_uses_correct_pull_request_selector(self):
        check = {'details_url': 'https://sonarcloud.io/dashboard?id=staguak_aktualizator-nl-ue&pullRequest=37'}
        self.assertEqual(sonar_selector(check), ('staguak_aktualizator-nl-ue', {'pullRequest': '37'}))
        urls = []
        def getter(url):
            urls.append(url)
            return {'issues': [], 'paging': {'total': 0}}
        sonar_api_snapshot(selector={'pullRequest': '37'}, getter=getter)
        self.assertTrue(all('pullRequest=37' in url for url in urls))

    def test_sonar_api_is_not_mistakenly_attached_to_wrong_branch(self):
        event = dict(repository=dict(full_name=REPO), check_run=dict(id=77, app=dict(slug='sonarqubecloud')))
        def getter(url, token=None):
            return dict(id=77, name='SonarCloud Code Analysis', app={'slug': 'sonarqubecloud'},
                        status='completed', conclusion='success', output={})
        report = export('check_run', event, GitHub(REPO, 'dummy', getter))
        self.assertEqual(report['sonarApi']['status'], 'unavailable')
        self.assertEqual(report['sonarApi']['reason'], 'SONAR_CHECK_HAS_NO_VERIFIED_ANALYSIS_URL')

    def test_untrusted_http_destination_is_refused_before_network(self):
        for url in ('https://example.net/api/issues/search',
                    'http://api.github.com/repos/a/b',
                    'https://api.github.com.evil.net/repos/a/b',
                    'https://sonarcloud.io/admin/settings',
                    'https://api.github.com/repos/a/../other'):
            with self.subTest(url=url):
                with self.assertRaises(ExportError):
                    fetch_json(url, 'do-not-send-this-token')

    def test_report_upload_keeps_diagnostics_even_on_export_failure(self):
        workflow = Path(__file__).resolve().parents[2] / '.github/workflows/report-storage.yml'
        source = workflow.read_text(encoding='utf-8')
        self.assertIn('Initialize fallback diagnostic artifact', source)
        self.assertIn('Remove fallback marker after successful export', source)
        self.assertIn('if: success()', source)
        self.assertIn('Save failure diagnostics', source)
        self.assertIn('sonar-check-{0}', source)
        self.assertIn('if: ${{ always() && (failure() || cancelled()) }}', source)
        self.assertIn('github-reports/export-incomplete.json', source)

    def test_trusted_exporter_decodes_multiline_github_contents_base64(self):
        workflow = Path(__file__).resolve().parents[2] / '.github/workflows/report-storage.yml'
        source = workflow.read_text(encoding='utf-8')
        self.assertIn("b64decode(''.join(payload['content'].split()), validate=True)", source)
        sample = base64.b64encode(b'print(42)').decode('ascii')
        github_content = sample[:4] + '\n' + sample[4:] + '\n'
        self.assertEqual(base64.b64decode(''.join(github_content.split()), validate=True),
                         b'print(42)')

    def test_cli_argument_cannot_change_report_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            event_path = root / 'event.json'
            event_path.write_text(json.dumps({'repository': {'full_name': REPO}}))
            old_cwd = Path.cwd()
            try:
                os.chdir(root)
                env = {'GITHUB_EVENT_PATH': str(event_path), 'GITHUB_REPOSITORY': REPO,
                       'GITHUB_TOKEN': 'fake', 'GITHUB_EVENT_NAME': 'workflow_run'}
                with patch.dict(os.environ, env), patch('export_run_reports.export', return_value={'type': 'test'}), \
                     patch.object(sys, 'argv', ['script', '../escape']):
                    self.assertEqual(main(), 0)
                self.assertTrue((root / 'github-reports' / 'report.json').is_file())
                self.assertFalse((root.parent / 'escape').exists())
            finally:
                os.chdir(old_cwd)

    def test_reconcile_id_is_authorized_by_api_not_arbitrary_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'event.json').write_text('{"repository":{"full_name":"' + REPO + '"}}')
            old_cwd = Path.cwd()
            events = []
            def record(event_name, event, _gh):
                events.append((event_name, event))
                return {'type': 'sonarqube-cloud'}
            try:
                os.chdir(root)
                env = {'GITHUB_EVENT_PATH': str(root / 'event.json'),
                       'GITHUB_REPOSITORY': REPO, 'GITHUB_TOKEN': 'fake',
                       'GITHUB_EVENT_NAME': 'schedule', 'SONAR_RECONCILE_CHECK_ID': '9001'}
                with patch.dict(os.environ, env), patch('export_run_reports.export', side_effect=record):
                    self.assertEqual(main(), 0)
                self.assertEqual(events[0][0], 'check_run')
                self.assertEqual(events[0][1]['check_run']['id'], 9001)
                self.assertEqual(events[0][1]['repository']['full_name'], REPO)
            finally:
                os.chdir(old_cwd)

    def test_reconcile_rejects_external_check_identifiers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'event.json').write_text('{}')
            old_cwd = Path.cwd()
            try:
                os.chdir(root)
                env = {'GITHUB_EVENT_PATH': str(root / 'event.json'),
                       'GITHUB_REPOSITORY': REPO, 'GITHUB_TOKEN': 'fake',
                       'GITHUB_EVENT_NAME': 'schedule', 'SONAR_RECONCILE_CHECK_ID': '../private'}
                with patch.dict(os.environ, env), patch('export_run_reports.export') as mocked:
                    self.assertEqual(main(), 1)
                    mocked.assert_not_called()
            finally:
                os.chdir(old_cwd)

    def test_git_api_rejects_bad_repo(self):
        with self.assertRaisesRegex(ExportError, 'INVALID_REPOSITORY'):
            GitHub('../../bad', 'dummy')


if __name__ == '__main__':
    unittest.main()
