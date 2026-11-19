"""Tests for bounded, idempotent SonarCloud artifact reconciliation."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from sonar_reconcile import discover, eligible_checks, select_missing, emit_output
from export_run_reports import ExportError

SHA = 'a' * 40
PR_SHA = 'b' * 40
REPO = 'staguak/aktualizator-nl-ue'
PROJECT = 'staguak_aktualizator-nl-ue'
NOW = datetime(2026, 11, 19, 1, 0, tzinfo=timezone.utc)


def sonar_check(check_id, sha=SHA, age_days=0, *, app='sonarqubecloud', state='completed',
                project=PROJECT):
    return {
        'id': check_id, 'head_sha': sha, 'status': state,
        'name': 'SonarCloud Code Analysis',
        'app': {'slug': app},
        'completed_at': (NOW - timedelta(days=age_days)).isoformat().replace('+00:00', 'Z'),
        'details_url': 'https://sonarcloud.io/dashboard?id=' + project + '&branch=main',
    }


class FakeGitHub:
    def __init__(self, checks, artifacts=None, pulls=None, error=None):
        self.checks = checks
        self.artifacts = artifacts or []
        self.pulls = pulls or []
        self.calls = []
        self.error = error

    def get(self, path):
        self.calls.append(path)
        if self.error and path.startswith(self.error):
            raise ExportError('HTTP_503')
        if path == '/git/ref/heads/main':
            return {'object': {'sha': SHA}}
        if path.startswith('/actions/artifacts?'):
            return {'artifacts': self.artifacts}
        if path.startswith('/pulls?'):
            return self.pulls
        if path.startswith('/branches?'):
            return []
        if '/check-runs?' in path:
            for sha in (SHA, PR_SHA):
                if path.startswith('/commits/' + sha + '/'):
                    return {'check_runs': self.checks.get(sha, []),
                            'total_count': len(self.checks.get(sha, []))}
        raise AssertionError(path)


class ReconciliationTests(unittest.TestCase):
    def test_eligible_checks_ignore_other_apps_projects_pending_and_expired(self):
        entries = [
            sonar_check(1),
            sonar_check(2, app='github-actions'),
            sonar_check(3, state='in_progress'),
            sonar_check(4, age_days=91),
            sonar_check(5, project='other_project'),
            sonar_check(6, age_days=88),
        ]
        result = eligible_checks(entries, now=NOW)
        self.assertEqual([x['id'] for x in result], [1, 6])

    def test_picks_main_and_pr_head_deduplicating_by_check_id(self):
        gh = FakeGitHub(
            {SHA: [sonar_check(10), sonar_check(11)], PR_SHA: [sonar_check(12, sha=PR_SHA)]},
            pulls=[{'head': {'sha': PR_SHA}}, {'head': {'sha': SHA}}],
        )
        result = discover(gh, now=NOW)
        self.assertEqual({x['id'] for x in result['checks']}, {10, 11, 12})
        queried = [x for x in gh.calls if '/check-runs?' in x]
        self.assertEqual(len(queried), 2)

    def test_skips_only_live_successful_check_specific_artifacts(self):
        checks = [sonar_check(101), sonar_check(102)]
        names = ['sonar-check-101', 'sonar-check-102', 'unrelated-report']
        # An expired artifact does not count as archived.
        gh = FakeGitHub({SHA: checks}, artifacts=[
            {'name': names[0], 'expired': False},
            {'name': names[1], 'expired': True},
            {'name': names[2], 'expired': False},
        ])
        result = discover(gh, now=NOW)
        self.assertEqual([x['id'] for x in result['checks']], [102])

    def test_newest_first_and_bounded_without_starvation(self):
        items = [sonar_check(i, age_days=i//3) for i in range(1, 30)]
        missing = select_missing(items, archived=set(), limit=3)
        self.assertEqual(len(missing), 3)
        archived = {f"sonar-check-{x['id']}" for x in missing}
        later = select_missing(items, archived=archived, limit=3)
        self.assertFalse(set(x['id'] for x in missing) & set(x['id'] for x in later))

    def test_empty_discovery_outputs_json_array(self):
        gh = FakeGitHub({SHA: []})
        result = discover(gh, now=NOW)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'output'
            emit_output(path, result['checks'])
            self.assertEqual(path.read_text().strip(), 'checks=[]')

    def test_repository_or_artifact_api_error_does_not_claim_success(self):
        gh = FakeGitHub({SHA: [sonar_check(1)]}, error='/actions/artifacts?')
        with self.assertRaisesRegex(ExportError, 'HTTP_503'):
            discover(gh, now=NOW)

    def test_rejects_incomplete_check_listing_instead_of_silent_loss(self):
        class TooManyChecks(FakeGitHub):
            def get(self, path):
                if '/check-runs?' in path:
                    return {'check_runs': [sonar_check(i) for i in range(100)], 'total_count': 1000}
                return super().get(path)
        with self.assertRaisesRegex(ExportError, 'INCOMPLETE_CHECK_HISTORY'):
            discover(TooManyChecks({}), now=NOW)

    def test_reconciliation_runs_only_after_main_push_verification(self):
        workflow = (ROOT.parent / '.github/workflows/sonar-reconciliation.yml').read_text()
        self.assertIn('workflow_run:', workflow)
        self.assertIn('Verify public updater code', workflow)
        self.assertIn("github.event.workflow_run.event == 'push'", workflow)
        self.assertIn("github.event.workflow_run.head_branch == 'main'", workflow)
        self.assertIn("github.event.workflow_run.head_repository.full_name == github.repository", workflow)
        self.assertNotIn('schedule:', workflow)
        self.assertNotIn('workflow_dispatch:', workflow)
        self.assertNotIn('sonarcloud-reconcile-frequent-poll', workflow)
        self.assertIn('sonar_reconcile.py', workflow)
        self.assertIn('fromJSON(needs.reconcile_discover.outputs.checks)', workflow)
        self.assertIn('sonar-check-', workflow)
        self.assertIn('retention-days: 90', workflow)


if __name__ == '__main__':
    unittest.main()
