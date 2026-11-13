"""Bounded Git/API calls and diagnostics without credential-bearing error text."""
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import traceback
import urllib.error
import urllib.request


class PublicError(RuntimeError):
    def __init__(self, code, stage, http_status=None):
        super().__init__(code)
        self.code = code
        self.stage = stage
        self.http_status = http_status


def parse_time(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None:
            raise ValueError()
        return result.astimezone(timezone.utc)
    except (AttributeError, TypeError, ValueError):
        raise PublicError('INVALID_TIMESTAMP', 'VALIDATION') from None


def authenticated_environment(token):
    if not token or '\n' in token or '\r' in token:
        raise PublicError('PUBLICATION_TOKEN_MISSING', 'AUTHENTICATION')
    env = dict(os.environ)
    env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.https://github.com/.extraheader',
               GIT_CONFIG_VALUE_0='AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:' + token).encode()).decode(),
               GIT_TERMINAL_PROMPT='0')
    return env


def git(directory, *args, env=None, acceptable=(0,)):
    operation = args[0] if args and args[0] in {'fetch', 'push', 'ls-remote'} else 'local'
    attempts = 3 if operation in {'fetch', 'ls-remote'} else 1
    for attempt in range(attempts):
        try:
            result = subprocess.run(['git', '-C', str(directory), *args], env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
        except subprocess.TimeoutExpired:
            if attempt + 1 < attempts:
                time.sleep(attempt + 1)
                continue
            raise PublicError('GIT_TIMEOUT', 'GIT_' + operation.upper()) from None
        if result.returncode in acceptable:
            return result
        stderr = result.stderr.lower()
        if b'authentication failed' in stderr or b'403' in stderr or b'permission denied' in stderr:
            code = 'GIT_ACCESS_DENIED'
        elif b'stale info' in stderr or b'cannot lock ref' in stderr or b'fetch first' in stderr:
            code = 'GIT_REF_CONFLICT'
        elif operation != 'local':
            code = 'GIT_TRANSPORT_FAILED'
        else:
            code = 'GIT_LOCAL_FAILED'
        if code == 'GIT_TRANSPORT_FAILED' and attempt + 1 < attempts:
            time.sleep(attempt + 1)
            continue
        raise PublicError(code, 'GIT_' + operation.upper())


class GitHubApi:
    def __init__(self, repo, token, opener=None, wait=None):
        if not re.fullmatch(r'[-A-Za-z0-9_.]+/[-A-Za-z0-9_.]+', repo):
            raise PublicError('REPOSITORY_INVALID', 'AUTHENTICATION')
        if not token:
            raise PublicError('PUBLICATION_TOKEN_MISSING', 'AUTHENTICATION')
        self.repo, self._token = repo, token
        self.opener = opener or urllib.request.urlopen
        self.wait = wait or time.sleep

    def request(self, suffix, payload=None, method='GET', attempts=3):
        if not suffix.startswith('/') or '..' in suffix:
            raise PublicError('API_ROUTE_INVALID', 'GITHUB_API')
        for attempt in range(attempts):
            request = urllib.request.Request('https://api.github.com/repos/' + self.repo + suffix,
                data=None if payload is None else json.dumps(payload).encode(), method=method,
                headers={'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + self._token,
                         'X-GitHub-Api-Version': '2022-11-28'})
            try:
                with self.opener(request, timeout=30) as response:
                    body = response.read(4_000_001)
                    if len(body) > 4_000_000:
                        raise PublicError('API_RESPONSE_LIMIT', 'GITHUB_API')
                    return json.loads(body) if body else None
            except urllib.error.HTTPError as error:
                status = error.code
                retryable = status in (408, 429, 500, 502, 503, 504)
                if retryable and attempt + 1 < attempts:
                    delay = attempt + 1
                    try:
                        delay = min(10, max(delay, float(error.headers.get('Retry-After', delay))))
                    except (AttributeError, TypeError, ValueError):
                        pass
                    self.wait(delay)
                    continue
                raise PublicError('GITHUB_HTTP_' + str(status), 'GITHUB_API', status) from None
            except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError):
                if attempt + 1 < attempts:
                    self.wait(attempt + 1)
                    continue
                raise PublicError('GITHUB_NETWORK_FAILED', 'GITHUB_API') from None
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise PublicError('API_RESPONSE_INVALID', 'GITHUB_API') from None


def executable_digest(app):
    """Fingerprint executable tracked files, independent of commit metadata/docs/tests."""
    tracked = git(app, 'ls-files', '-z').stdout.decode().split('\0')
    fixed = {'package.json', 'package-lock.json', '.node-version'}
    files = []
    for name in filter(None, tracked):
        p = Path(name)
        executable = (name.startswith('src/') and name.endswith('.ts')
                      and not name.endswith(('.test.ts', '.integration.ts')) and p.name != 'parser-selftest.ts')
        helper = name.startswith('scripts/') and p.suffix in {'.ts', '.py', '.txt'} and not p.name.startswith('test_')
        schema = name in {'docs/schema-research/catalog.json', 'docs/schema-research/official-schemas.zip'}
        if name in fixed or executable or helper or schema:
            files.append(name)
    if not files or not fixed <= set(files):
        raise PublicError('EXECUTABLE_TREE_INCOMPLETE', 'FINGERPRINT')
    digest = hashlib.sha256(b'public-execution-v1\0')
    for name in sorted(files):
        target = app / name
        if target.is_symlink() or not target.is_file():
            raise PublicError('EXECUTABLE_FILE_UNSAFE', 'FINGERPRINT')
        blob = target.read_bytes()
        digest.update(name.encode() + b'\0' + str(len(blob)).encode() + b'\0' + blob)
    workflow = app.parent / '.github/workflows/public-corpus.yml'
    if workflow.exists():
        if workflow.is_symlink() or not workflow.is_file():
            raise PublicError('EXECUTABLE_FILE_UNSAFE', 'FINGERPRINT')
        digest.update(b'.github/workflows/public-corpus.yml\0' + workflow.read_bytes())
    return digest.hexdigest()


def safe_diagnostic(error, stage):
    if isinstance(error, PublicError):
        code, stage, status = error.code, error.stage, error.http_status
    else:
        status = None
        code = ('INVALID_JSON' if isinstance(error, json.JSONDecodeError)
                else 'MISSING_INPUT' if isinstance(error, FileNotFoundError)
                else 'LOCAL_PERMISSION_DENIED' if isinstance(error, PermissionError)
                else 'VALIDATION_FAILED' if isinstance(error, ValueError)
                else 'UNEXPECTED_FAILURE')
    # Only fixed codes, stage labels and numeric statuses enter logs.
    if not re.fullmatch('[A-Z0-9_]{2,80}', code):
        code = 'UNEXPECTED_FAILURE'
    if not re.fullmatch('[A-Z0-9_]{2,80}', stage):
        stage = 'UNKNOWN'
    record = {'code': code, 'stage': stage, 'httpStatus': status,
              'at': datetime.now(timezone.utc).isoformat()}
    own = {'public_github.py', 'public_admission.py', 'public_support.py'}
    frames = [frame for frame in traceback.extract_tb(error.__traceback__) if Path(frame.filename).name in own]
    if frames:
        record['location'] = Path(frames[-1].filename).name + ':' + str(frames[-1].lineno)
    return record


def record_diagnostic(control, error, stage, warning=False):
    record = safe_diagnostic(error, stage)
    control.mkdir(parents=True, exist_ok=True)
    with (control / ('warnings.jsonl' if warning else 'errors.jsonl')).open('a') as f:
        f.write(json.dumps(record) + '\n')
    level = 'warning' if warning else 'error'
    print(f'::{level} title=Publiczna baza NL/UE::{record["code"]}; etap={record["stage"]}'
          + (f'; HTTP={record["httpStatus"]}' if record['httpStatus'] else '')
          + ('; ' + record['location'] if record.get('location') else ''), flush=True)
    return record
