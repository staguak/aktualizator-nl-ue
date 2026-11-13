"""No-queue admission, stale-run recovery and lease ownership on a real bare Git remote."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

APP = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'scripts'))
import public_admission
from public_admission import StateStore, acquire, release, REF, WORKFLOW
from public_support import PublicError, git

NOW = datetime(2026, 11, 13, 12, tzinfo=timezone.utc)
REV = 'a' * 40
REPO = 'example/updater'


class Api:
    repo = REPO
    completed = False

    def request(self, route):
        run = route.split('/')[3]
        return {'id': int(run), 'run_attempt': 1, 'repository': {'full_name': REPO},
                'path': WORKFLOW, 'head_sha': REV, 'status': 'completed' if self.completed else 'in_progress',
                'updated_at': (NOW + timedelta(seconds=20)).isoformat()}


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.remote = self.root / 'remote.git'
        subprocess.run(['git', 'init', '--quiet', '--bare', str(self.remote)], check=True)
        self.app = self.root / 'app'
        self.app.mkdir()
        self.api = Api()

    def store(self, name):
        return StateStore(self.app, self.root / name, REPO, str(self.remote))

    def admit(self, store, run, requested=NOW, at=NOW):
        return acquire(store, self.api, run, 1, REV, requested, at)

    def test_concurrent_requests_have_one_winner_and_one_rejection(self):
        stores = [self.store('one'), self.store('two')]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda item: self.admit(*item), [(stores[0], '101'), (stores[1], '102')]))
        self.assertEqual(sum(r['accepted'] for r in results), 1)
        loser = next(r for r in results if not r['accepted'])
        self.assertEqual(loser['reason'], 'UPDATER_BUSY')
        self.assertEqual(git(self.remote, 'rev-list', '--count', 'updater-state').stdout.strip(), b'1')

    def test_request_arriving_during_work_is_rejected_even_if_runner_started_after_release(self):
        store = self.store('first')
        receipt = self.admit(store, '101')
        release(store, receipt, 'PUBLISHED', NOW + timedelta(seconds=20))
        old_head = store.head()
        delayed = self.admit(self.store('delayed'), '102', NOW + timedelta(seconds=10), NOW + timedelta(seconds=40))
        self.assertFalse(delayed['accepted'])
        self.assertEqual(delayed['reason'], 'REQUEST_DURING_PREVIOUS_RUN')
        self.assertEqual(store.head(), old_head)
        next_run = self.admit(self.store('new'), '103', NOW + timedelta(seconds=25), NOW + timedelta(seconds=45))
        self.assertTrue(next_run['accepted'])

    def test_completed_owner_is_recovered_but_active_owner_is_never_stolen(self):
        first = self.store('first')
        self.assertTrue(self.admit(first, '101')['accepted'])
        blocked = self.admit(self.store('blocked'), '102', NOW + timedelta(seconds=10))
        self.assertFalse(blocked['accepted'])
        self.api.completed = True
        recovered = self.admit(self.store('recovered'), '103', NOW + timedelta(seconds=30), NOW + timedelta(seconds=40))
        self.assertTrue(recovered['accepted'])

    def test_old_owner_cannot_release_new_owner_and_idle_history_stays_one_commit(self):
        first = self.store('first')
        receipt = self.admit(first, '101')
        self.api.completed = True
        second = self.store('second')
        replacement = self.admit(second, '102', NOW + timedelta(seconds=30), NOW + timedelta(seconds=40))
        with self.assertRaisesRegex(PublicError, 'LOCK_OWNERSHIP_CHANGED'):
            release(first, receipt, 'FAILED', NOW + timedelta(seconds=50))
        self.assertTrue(release(second, replacement, 'REUSED', NOW + timedelta(seconds=60)))
        self.assertTrue(release(second, replacement, 'REUSED', NOW + timedelta(seconds=61)))
        sha, state = second.read()
        self.assertEqual(state['status'], 'IDLE')
        self.assertEqual(state['runId'], '102')
        self.assertEqual(git(self.remote, 'rev-list', '--count', 'updater-state').stdout.strip(), b'1')

    def test_unknown_owner_or_api_failure_fails_closed(self):
        store = self.store('first')
        self.admit(store, '101')
        expected = store.head()
        class Denied(Api):
            def request(self, route):
                raise PublicError('GITHUB_HTTP_403', 'GITHUB_API', 403)
        with self.assertRaises(PublicError):
            acquire(self.store('denied'), Denied(), '102', 1, REV, NOW + timedelta(seconds=30))
        self.assertEqual(store.head(), expected)

    def test_lost_successful_push_reply_is_reconciled_without_a_second_admission(self):
        store = self.store('lost-reply')
        real_git = public_admission.git
        lost = []
        def interrupted(directory, *args, **kwargs):
            result = real_git(directory, *args, **kwargs)
            if args[0] == 'push' and not lost:
                lost.append(True)
                raise PublicError('GIT_TRANSPORT_FAILED', 'GIT_PUSH')
            return result
        with patch.object(public_admission, 'git', side_effect=interrupted):
            receipt = self.admit(store, '101')
        self.assertTrue(receipt['accepted'])
        self.assertFalse(self.admit(self.store('contender'), '102')['accepted'])
        self.assertEqual(git(self.remote, 'rev-list', '--count', 'updater-state').stdout.strip(), b'1')

    def test_a_new_request_can_start_immediately_after_the_idle_write_is_acknowledged(self):
        store = self.store('first')
        receipt = self.admit(store, '101')
        original = store.compare_and_set
        next_owner = []
        def handover(expected, value):
            result = original(expected, value)
            if value['status'] == 'IDLE':
                next_owner.append(self.admit(self.store('next'), '102', NOW + timedelta(seconds=30), NOW + timedelta(seconds=40)))
            return result
        with patch.object(store, 'compare_and_set', side_effect=handover):
            self.assertTrue(release(store, receipt, 'PUBLISHED', NOW + timedelta(seconds=20)))
        self.assertTrue(next_owner[0]['accepted'])
        self.assertEqual(store.read()[1]['runId'], '102')


if __name__ == '__main__':
    unittest.main()
