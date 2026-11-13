"""A single-writer lease. Contenders are rejected; no waiting queue exists.

The updater-state branch has one parentless commit with one bounded JSON file.
Idle state remembers the last operation window so delayed requests cannot turn
into another update after the active operation has already completed.
"""
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import uuid
from public_support import PublicError, authenticated_environment, git, parse_time

REF = 'refs/heads/updater-state'
PROFILE = 'public-updater-admission-v1'
WORKFLOW = '.github/workflows/public-corpus.yml'


def validate_state(value, repo):
    if (not isinstance(value, dict) or value.get('profile') != PROFILE or value.get('repository') != repo
            or value.get('status') not in {'RUNNING', 'IDLE'}
            or not re.fullmatch('[1-9][0-9]*', value.get('runId', ''))
            or not isinstance(value.get('attempt'), int) or value['attempt'] < 1
            or not re.fullmatch('[a-f0-9]{40}', value.get('revision', ''))
            or not re.fullmatch('[a-f0-9]{32}', value.get('nonce', ''))):
        raise PublicError('ADMISSION_STATE_INVALID', 'ADMISSION')
    start = parse_time(value.get('startedAt'))
    if value['status'] == 'IDLE' and parse_time(value.get('finishedAt')) < start:
        raise PublicError('ADMISSION_STATE_INVALID', 'ADMISSION')
    return value


class StateStore:
    def __init__(self, app, directory, repo, remote, env=None):
        self.app, self.directory = app, directory
        self.repo, self.remote, self.env = repo, remote, env
        directory.mkdir(parents=True, exist_ok=True)

    def head(self):
        result = git(self.app, 'ls-remote', '--exit-code', '--heads', self.remote, REF,
                     env=self.env, acceptable=(0, 2))
        if result.returncode == 2:
            return ''
        rows = result.stdout.decode().splitlines()
        if len(rows) != 1 or not re.fullmatch('[a-f0-9]{40}\\s+' + re.escape(REF), rows[0]):
            raise PublicError('ADMISSION_REF_INVALID', 'ADMISSION')
        return rows[0].split()[0]

    def read(self):
        expected = self.head()
        if not expected:
            return '', None
        database = self.directory / ('read-' + uuid.uuid4().hex)
        database.mkdir()
        git(database, 'init', '--quiet', '--bare')
        git(database, 'fetch', '--quiet', '--no-tags', '--depth=1', self.remote, REF, env=self.env)
        actual = git(database, 'rev-parse', 'FETCH_HEAD').stdout.decode().strip()
        if actual != expected:
            raise PublicError('ADMISSION_CHANGED', 'ADMISSION')
        tree = git(database, 'ls-tree', '-r', 'FETCH_HEAD').stdout.decode().splitlines()
        if len(tree) != 1 or not re.fullmatch('100644 blob [a-f0-9]{40}\\tstate.json', tree[0]):
            raise PublicError('ADMISSION_TREE_INVALID', 'ADMISSION')
        size = int(git(database, 'cat-file', '-s', 'FETCH_HEAD:state.json').stdout)
        if not 0 < size <= 16_000:
            raise PublicError('ADMISSION_STATE_LIMIT', 'ADMISSION')
        commit = git(database, 'cat-file', '-p', 'FETCH_HEAD').stdout.split(b'\n\n', 1)[0]
        if any(line.startswith(b'parent ') for line in commit.splitlines()):
            raise PublicError('ADMISSION_HISTORY_INVALID', 'ADMISSION')
        value = json.loads(git(database, 'show', 'FETCH_HEAD:state.json').stdout)
        return actual, validate_state(value, self.repo)

    def compare_and_set(self, expected, value):
        validate_state(value, self.repo)
        if expected and not re.fullmatch('[a-f0-9]{40}', expected):
            raise PublicError('ADMISSION_REF_INVALID', 'ADMISSION')
        directory = self.directory / ('write-' + uuid.uuid4().hex)
        directory.mkdir()
        (directory / 'state.json').write_text(json.dumps(value, indent=2) + '\n')
        git(directory, 'init', '--quiet', '--initial-branch=updater-state')
        git(directory, 'config', 'user.name', 'github-actions[bot]')
        git(directory, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
        git(directory, 'add', 'state.json')
        git(directory, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Record current updater admission state')
        new = git(directory, 'rev-parse', 'HEAD').stdout.decode().strip()
        try:
            git(directory, 'push', '--quiet', '--force-with-lease=' + REF + ':' + expected,
                self.remote, 'HEAD:' + REF, env=self.env)
        except PublicError:
            actual = self.head()
            if actual == new:
                return new  # A lost reply cannot turn a completed CAS into a second writer.
            if actual != expected:
                return None
            raise
        # A successful atomic push is the acknowledgement. Requiring the ref
        # to remain unchanged afterwards would misreport a normal contender
        # acquiring the just-released IDLE state as a failed release.
        return new


def run_attempt(api, run, attempt):
    value = api.request('/actions/runs/' + run + '/attempts/' + str(attempt))
    if (not isinstance(value, dict) or str(value.get('id')) != run or value.get('run_attempt') != attempt
            or value.get('path', '').split('@')[0] != WORKFLOW
            or value.get('repository', {}).get('full_name') != api.repo):
        raise PublicError('RUN_IDENTITY_UNVERIFIED', 'ADMISSION')
    return value


def request_time(api, run, attempt):
    value = run_attempt(api, run, attempt)
    return parse_time(value.get('run_started_at') if attempt > 1 else value.get('created_at'))


def acquire(store, api, run, attempt, revision, requested_at, now=None):
    now = now or datetime.now(timezone.utc)
    for _ in range(3):  # CAS conflicts are inspected immediately; never wait for a turn.
        try:
            old_sha, previous = store.read()
        except PublicError as error:
            if error.code == 'ADMISSION_CHANGED':
                continue
            raise
        finished = None
        if previous:
            if previous['status'] == 'RUNNING':
                owner = run_attempt(api, previous['runId'], previous['attempt'])
                if owner.get('head_sha') != previous['revision']:
                    raise PublicError('LOCK_OWNER_UNVERIFIED', 'ADMISSION')
                if owner.get('status') != 'completed':
                    return {'accepted': False, 'reason': 'UPDATER_BUSY', 'ownerRun': previous['runId']}
                finished = max(parse_time(owner['updated_at']), parse_time(previous['startedAt']))
            else:
                finished = parse_time(previous['finishedAt'])
            if requested_at <= finished:
                reason = 'REQUEST_SUPERSEDED' if requested_at < parse_time(previous['startedAt']) else 'REQUEST_DURING_PREVIOUS_RUN'
                return {'accepted': False, 'reason': reason, 'ownerRun': previous['runId']}
        state = {'profile': PROFILE, 'repository': store.repo, 'status': 'RUNNING', 'runId': run,
                 'attempt': attempt, 'revision': revision, 'nonce': uuid.uuid4().hex,
                 'requestedAt': requested_at.isoformat(), 'startedAt': now.isoformat()}
        new = store.compare_and_set(old_sha, state)
        if new:
            return {'accepted': True, 'sha': new, 'state': state}
    raise PublicError('ADMISSION_CONTENTION', 'ADMISSION')


def release(store, receipt, result, now=None):
    if not receipt or not receipt.get('accepted'):
        return False
    now = now or datetime.now(timezone.utc)
    sha, value = store.read()
    state = receipt['state']
    same_owner = value and all(value.get(k) == state.get(k) for k in ('runId', 'attempt', 'revision', 'nonce'))
    if same_owner and value['status'] == 'IDLE':
        return True
    if sha != receipt['sha'] or not same_owner or value['status'] != 'RUNNING':
        raise PublicError('LOCK_OWNERSHIP_CHANGED', 'RELEASE')
    idle = {**state, 'status': 'IDLE', 'finishedAt': max(now, parse_time(state['startedAt'])).isoformat(),
            'lastResult': result if result in {'PUBLISHED', 'REUSED', 'FAILED'} else 'FAILED'}
    if not store.compare_and_set(sha, idle):
        raise PublicError('LOCK_RELEASE_CONFLICT', 'RELEASE')
    return True
