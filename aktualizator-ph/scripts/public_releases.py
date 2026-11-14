"""Verified, retryable public Releases and restorable updater state.

The caller owns admission and the atomic ``dane`` pointer. A published Release
does not by itself change that pointer. Only namespaced releases are collected.
Binary bodies are streamed; source/state archives never become JSON base64.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from public_support import PublicError, parse_time


PROFILE = 'public-data-release-v1'
STATE_PROFILE = 'public-updater-state-v1'
MARKER = '<!-- ' + PROFILE + ' -->\n'
STATE_MANIFEST = 'state-manifest.json'
STATE_NAMES = frozenset({'.source-cache', '.checkpoint', '.checkpoint-ue',
                         '.source-diagnostics', 'output', 'output-ue'})
BLOCK = 1024 * 1024


def file_digest(path):
    value, size = hashlib.sha256(), 0
    with Path(path).open('rb') as source:
        while chunk := source.read(BLOCK):
            size += len(chunk)
            value.update(chunk)
    return size, value.hexdigest()


def safe_name(value):
    if (not isinstance(value, str) or not value or len(value) > 240
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', value)
            or '..' in value):
        raise PublicError('RELEASE_ASSET_NAME_INVALID', 'RELEASE')
    return value


def _relative(value):
    if (not isinstance(value, str) or not value or '\\' in value or '\x00' in value
            or ':' in value or len(value) > 4096
            or any(part in {'', '.', '..'} for part in value.split('/'))
            or PurePosixPath(value).is_absolute()):
        raise PublicError('STATE_PATH_INVALID', 'STATE_ARCHIVE')
    return PurePosixPath(value)


def _identity(run_id, attempt, code_sha):
    if (not re.fullmatch(r'[1-9][0-9]*', str(run_id)) or type(attempt) is not int or attempt < 1
            or not re.fullmatch(r'[a-f0-9]{40}', code_sha)):
        raise PublicError('RELEASE_IDENTITY_INVALID', 'RELEASE')
    return 'data-' + str(run_id) + '-' + str(attempt)


def release_record(value):
    """An ownership marker alone is insufficient to authorize deletion."""
    if not isinstance(value, dict) or not isinstance(value.get('body'), str):
        return None
    body = value['body']
    if not body.startswith(MARKER):
        return None
    try:
        record = json.loads(body[len(MARKER):])
        expected = _identity(record['runId'], record['attempt'], record['codeRevision'])
        if (record['profile'] != PROFILE or value.get('tag_name') != expected
                or record['status'] not in {'PUBLISHED', 'FAILED', 'REUSED'}
                or type(value.get('id')) is not int or value['id'] < 1):
            return None
        parse_time(record['createdAt'])
        return record
    except (ValueError, KeyError, TypeError, PublicError):
        return None


class _ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if (parsed.scheme != 'https' or parsed.username or parsed.password
                or parsed.hostname not in {'api.github.com', 'github.com', 'release-assets.githubusercontent.com',
                                           'objects.githubusercontent.com'}):
            raise PublicError('RELEASE_REDIRECT_REJECTED', 'RELEASE_DOWNLOAD')
        result = super().redirect_request(request, fp, code, message, headers, newurl)
        if result is not None and parsed.hostname != urllib.parse.urlsplit(request.full_url).hostname:
            result.remove_header('Authorization')
            result.remove_header('Cookie')
        return result


class ReleaseStore:
    def __init__(self, api, binary_opener=None):
        self.api = api
        self.binary_opener = binary_opener or urllib.request.build_opener(_ReleaseRedirect()).open

    def _binary(self, url, method='GET', source=None, length=None, accept='application/octet-stream'):
        parsed = urllib.parse.urlsplit(url)
        expected = 'uploads.github.com' if method == 'POST' else 'api.github.com'
        if (parsed.scheme != 'https' or parsed.hostname != expected or parsed.username or parsed.password
                or parsed.port not in {None, 443}
                or not parsed.path.startswith('/repos/' + self.api.repo + '/releases/')):
            raise PublicError('RELEASE_BINARY_ROUTE_INVALID', 'RELEASE_TRANSFER')
        headers = {'Authorization': 'Bearer ' + self.api._token, 'Accept': accept,
                   'X-GitHub-Api-Version': '2022-11-28'}
        if method == 'POST':
            headers.update({'Content-Type': 'application/octet-stream', 'Content-Length': str(length)})
        request = urllib.request.Request(url, data=source, headers=headers, method=method)
        return self.binary_opener(request, timeout=120)

    @staticmethod
    def _number(value):
        if type(value) is not int or value < 1:
            raise PublicError('RELEASE_RESPONSE_INVALID', 'RELEASE')
        return str(value)

    def _get_tag(self, tag):
        try:
            return self.api.request('/releases/tags/' + urllib.parse.quote(tag, safe=''))
        except PublicError as error:
            if error.http_status == 404:
                return None
            raise

    def _verify_tag(self, tag, revision, required=False):
        """A pre-existing tag must never redirect an owned release elsewhere."""
        try:
            value = self.api.request('/git/ref/tags/' + urllib.parse.quote(tag, safe=''))
        except PublicError as error:
            if error.http_status == 404 and not required:
                return
            raise
        for _ in range(4):
            target = value.get('object', {}) if isinstance(value, dict) else {}
            if target.get('type') == 'commit' and target.get('sha') == revision:
                return
            if target.get('type') != 'tag' or not re.fullmatch('[a-f0-9]{40}', target.get('sha', '')):
                break
            value = self.api.request('/git/tags/' + target['sha'])
        raise PublicError('RELEASE_TAG_REVISION_MISMATCH', 'RELEASE')

    def _list(self, route):
        result = []
        for page in range(1, 101):
            values = self.api.request(route + ('&' if '?' in route else '?') + 'per_page=100&page=' + str(page))
            if not isinstance(values, list):
                raise PublicError('RELEASE_LIST_INVALID', 'RELEASE')
            result.extend(values)
            if len(values) < 100:
                return result
        raise PublicError('RELEASE_LIST_INCOMPLETE', 'RELEASE')

    def assets(self, release_id):
        return self._list('/releases/' + self._number(release_id) + '/assets')

    def _asset_matches(self, asset, size, digest):
        if asset.get('size') != size or asset.get('state', 'uploaded') != 'uploaded':
            return False
        reported = asset.get('digest')
        if reported is not None:
            return reported == 'sha256:' + digest
        # Older GitHub responses may omit the server digest. Confirm the remote
        # bytes instead of treating equal size as an integrity guarantee.
        value, actual = hashlib.sha256(), 0
        url = 'https://api.github.com/repos/' + self.api.repo + '/releases/assets/' + self._number(asset.get('id'))
        try:
            with self._binary(url) as response:
                while chunk := response.read(BLOCK):
                    actual += len(chunk)
                    if actual > size:
                        return False
                    value.update(chunk)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError):
            raise PublicError('RELEASE_ASSET_VERIFY_FAILED', 'RELEASE_DOWNLOAD') from None
        return actual == size and value.hexdigest() == digest

    def _upload(self, release_id, name, path, size, digest):
        route = '/releases/' + self._number(release_id) + '/assets'
        for attempt in range(3):
            matches = [asset for asset in self.assets(release_id) if asset.get('name') == name]
            if len(matches) > 1:
                raise PublicError('RELEASE_ASSET_DUPLICATE', 'RELEASE_UPLOAD')
            if matches:
                if self._asset_matches(matches[0], size, digest):
                    return matches[0]
                # This is our unpublished draft: incomplete/mismatched assets
                # can be retried without replacing a reader-visible payload.
                self.api.request('/releases/assets/' + self._number(matches[0]['id']), method='DELETE')
            url = 'https://uploads.github.com/repos/' + self.api.repo + route + '?' + urllib.parse.urlencode({'name': name})
            try:
                with Path(path).open('rb') as source, self._binary(url, 'POST', source, size,
                                                                 'application/vnd.github+json') as response:
                    raw = response.read(4_000_001)
                    if len(raw) > 4_000_000:
                        raise PublicError('RELEASE_UPLOAD_REPLY_LIMIT', 'RELEASE_UPLOAD')
                    asset = json.loads(raw)
                if self._asset_matches(asset, size, digest):
                    return asset
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, socket.timeout,
                    ConnectionError, json.JSONDecodeError, UnicodeDecodeError):
                # A failed reply can follow a successful upload. Reconcile at
                # the beginning of the next attempt before issuing another POST.
                pass
            if attempt < 2:
                self.api.wait(attempt + 1)
        # Also reconcile a reply lost on the final attempt.
        for asset in self.assets(release_id):
            if asset.get('name') == name and self._asset_matches(asset, size, digest):
                return asset
        raise PublicError('RELEASE_UPLOAD_FAILED', 'RELEASE_UPLOAD')

    def stage(self, directory, run_id, attempt, code_sha, status='PUBLISHED', metadata=None):
        """Upload and verify a complete draft; does not alter active data."""
        tag = _identity(run_id, attempt, code_sha)
        if status not in {'PUBLISHED', 'FAILED', 'REUSED'}:
            raise PublicError('RELEASE_STATUS_INVALID', 'RELEASE')
        directory = Path(directory)
        if directory.is_symlink() or not directory.is_dir():
            raise PublicError('RELEASE_DIRECTORY_INVALID', 'RELEASE')
        paths = sorted(directory.iterdir())
        if not paths or len(paths) > 1000:
            raise PublicError('RELEASE_ASSET_COUNT_INVALID', 'RELEASE')
        inventory = []
        for path in paths:
            safe_name(path.name)
            if path.is_symlink() or not path.is_file():
                raise PublicError('RELEASE_ASSET_UNSAFE', 'RELEASE')
            size, digest = file_digest(path)
            if size >= 2 * 1024 ** 3:
                raise PublicError('RELEASE_ASSET_PLATFORM_LIMIT', 'RELEASE')
            inventory.append({'name': path.name, 'size': size, 'sha256': digest})
        record = {'profile': PROFILE, 'runId': str(run_id), 'attempt': attempt,
                  'codeRevision': code_sha, 'status': status, 'assets': inventory,
                  'createdAt': datetime.now(timezone.utc).isoformat(), 'metadata': metadata or {}}
        body = MARKER + json.dumps(record, ensure_ascii=False, sort_keys=True)
        if len(body.encode()) > 120_000:
            raise PublicError('RELEASE_RECORD_LIMIT', 'RELEASE')
        self._verify_tag(tag, code_sha)
        release = self._get_tag(tag)
        if release:
            old = release_record(release)
            if (not old or old['codeRevision'] != code_sha or old['status'] != status
                    or old['assets'] != inventory or old.get('metadata', {}) != record['metadata']):
                raise PublicError('RELEASE_IDENTITY_CONFLICT', 'RELEASE')
            if not release.get('draft'):
                self.verify(release)
                return release
        else:
            try:
                release = self.api.request('/releases', {'tag_name': tag, 'target_commitish': code_sha,
                    'name': 'Publiczna baza NL/UE ' + str(run_id) + '/' + str(attempt), 'body': body,
                    'draft': True, 'prerelease': status != 'PUBLISHED'}, 'POST', attempts=1)
            except PublicError:
                release = self._get_tag(tag)
                if not release or not release_record(release):
                    raise
                existing = release_record(release)
                if (existing['codeRevision'] != code_sha or existing['status'] != status
                        or existing['assets'] != inventory or existing.get('metadata', {}) != record['metadata']):
                    raise PublicError('RELEASE_IDENTITY_CONFLICT', 'RELEASE') from None
        if not release.get('draft'):
            raise PublicError('RELEASE_NOT_DRAFT', 'RELEASE')
        for path, entry in zip(paths, inventory):
            self._upload(release['id'], entry['name'], path, entry['size'], entry['sha256'])
        release = self.api.request('/releases/' + self._number(release['id']))
        self.verify(release)
        return release

    def verify(self, release):
        record = release_record(release)
        if not record:
            raise PublicError('RELEASE_RECORD_INVALID', 'RELEASE')
        self._verify_tag(release['tag_name'], record['codeRevision'], required=not release.get('draft'))
        entries = record.get('assets')
        if (not isinstance(entries, list) or not entries or len(entries) > 1000
                or any(not isinstance(entry, dict) for entry in entries)):
            raise PublicError('RELEASE_RECORD_INVALID', 'RELEASE')
        assets = self.assets(release['id'])
        names = [asset.get('name') for asset in assets]
        expected = [entry.get('name') for entry in entries]
        if len(set(expected)) != len(expected) or sorted(names) != sorted(expected):
            raise PublicError('RELEASE_INCOMPLETE', 'RELEASE')
        for entry in entries:
            safe_name(entry['name'])
            if (type(entry.get('size')) is not int or entry['size'] < 0
                    or not re.fullmatch('[a-f0-9]{64}', entry.get('sha256', ''))):
                raise PublicError('RELEASE_RECORD_INVALID', 'RELEASE')
            asset = next(asset for asset in assets if asset['name'] == entry['name'])
            if not self._asset_matches(asset, entry['size'], entry['sha256']):
                raise PublicError('RELEASE_ASSET_MISMATCH', 'RELEASE')
        return record

    def reconcile_draft(self, release, directory, status='FAILED', metadata=None):
        """Replan this unpublished attempt from surviving local material.

        Keeps its original timestamp; never rewrites a reader-visible release.
        Re-entering stage fills missing uploads and reconciles lost replies.
        """
        old=release_record(release)
        if not old or not release.get('draft'):
            raise PublicError('RELEASE_RECOVERY_NOT_DRAFT','RELEASE_RECOVERY')
        current=self._get_tag(release['tag_name'])
        if not current or release_record(current)!=old or not current.get('draft'):
            raise PublicError('RELEASE_RECOVERY_CHANGED','RELEASE_RECOVERY')
        directory=Path(directory)
        if directory.is_symlink() or not directory.is_dir():
            raise PublicError('RELEASE_DIRECTORY_INVALID','RELEASE_RECOVERY')
        inventory=[]
        for path in sorted(directory.iterdir()):
            safe_name(path.name)
            if path.is_symlink() or not path.is_file():raise PublicError('RELEASE_ASSET_UNSAFE','RELEASE_RECOVERY')
            size,digest=file_digest(path)
            if size>=2*1024**3:raise PublicError('RELEASE_ASSET_PLATFORM_LIMIT','RELEASE_RECOVERY')
            inventory.append(dict(name=path.name,size=size,sha256=digest))
        if not inventory or len(inventory)>1000:raise PublicError('RELEASE_ASSET_COUNT_INVALID','RELEASE_RECOVERY')
        actual=self.assets(release['id']);old_names={a['name'] for a in old['assets']};new_names={a['name'] for a in inventory}
        if any(a['name'] not in old_names for a in actual):raise PublicError('RELEASE_RECOVERY_CHANGED','RELEASE_RECOVERY')
        for asset in actual:
            if asset['name'] not in new_names:self.api.request('/releases/assets/'+self._number(asset['id']),method='DELETE')
        record=dict(old,status=status,assets=inventory,metadata=old.get('metadata',{}) if metadata is None else metadata)
        body=MARKER+json.dumps(record,ensure_ascii=False,sort_keys=True)
        if len(body.encode())>120000:raise PublicError('RELEASE_RECORD_LIMIT','RELEASE_RECOVERY')
        self.api.request('/releases/'+self._number(release['id']),{'body':body,'prerelease':status!='PUBLISHED'},'PATCH')
        return self.stage(directory,old['runId'],old['attempt'],old['codeRevision'],status,record['metadata'])

    def publish(self, release):
        record = self.verify(release)
        route = '/releases/' + self._number(release['id'])
        if release.get('draft'):
            try:
                release = self.api.request(route, {'draft': False, 'make_latest': 'true' if record['status'] == 'PUBLISHED' else 'false'},
                                           'PATCH', attempts=1)
            except PublicError:
                release = self.api.request(route)
                if release.get('draft'):
                    raise
        self.verify(release)
        return release

    def record_attempt(self, directory, run_id, attempt, code_sha, status, metadata=None):
        """Store failed/REUSED reports without changing any active-data pointer."""
        return self.publish(self.stage(directory, run_id, attempt, code_sha, status, metadata))

    def restore(self, release_id, target, expected_assets=None, asset_names=None):
        """Download verified assets into a new directory; cleanup on failure."""
        release = self.api.request('/releases/' + self._number(release_id))
        record = self.verify(release)
        if release.get('draft'):
            raise PublicError('RELEASE_UNPUBLISHED', 'RELEASE_DOWNLOAD')
        if expected_assets is not None and record['assets'] != expected_assets:
            raise PublicError('RELEASE_INVENTORY_CHANGED', 'RELEASE_DOWNLOAD')
        selected = record['assets']
        if asset_names is not None:
            wanted = set(asset_names)
            if not wanted or not wanted <= {entry['name'] for entry in selected}:
                raise PublicError('RELEASE_ASSET_SELECTION_INVALID', 'RELEASE_DOWNLOAD')
            selected = [entry for entry in selected if entry['name'] in wanted]
        target = Path(target)
        if target.exists() or target.is_symlink():
            raise PublicError('RESTORE_TARGET_EXISTS', 'RELEASE_DOWNLOAD')
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.release-download-', dir=target.parent) as temporary:
            stage = Path(temporary)
            assets = {a['name']: a for a in self.assets(release_id)}
            for entry in selected:
                value, size = hashlib.sha256(), 0
                url = 'https://api.github.com/repos/' + self.api.repo + '/releases/assets/' + self._number(assets[entry['name']]['id'])
                try:
                    with self._binary(url) as source, (stage / entry['name']).open('xb') as out:
                        while chunk := source.read(BLOCK):
                            size += len(chunk)
                            if size > entry['size']:
                                raise PublicError('RELEASE_DOWNLOAD_SIZE_MISMATCH', 'RELEASE_DOWNLOAD')
                            value.update(chunk)
                            out.write(chunk)
                except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError):
                    raise PublicError('RELEASE_DOWNLOAD_FAILED', 'RELEASE_DOWNLOAD') from None
                if size != entry['size'] or value.hexdigest() != entry['sha256']:
                    raise PublicError('RELEASE_DOWNLOAD_HASH_MISMATCH', 'RELEASE_DOWNLOAD')
            os.replace(stage, target)
        return record

    def recent_attempts(self):
        records = [(release, release_record(release)) for release in self._list('/releases')]
        records = [(release, record) for release, record in records if record and not release.get('draft')]
        records.sort(key=lambda item: (parse_time(item[1]['createdAt']), int(item[1]['runId']), item[1]['attempt']), reverse=True)
        return [release for release, _ in records]

    def recover_abandoned_drafts(self, owner_run, owner_attempt):
        """Keep verified partial uploads and a FAILED record after interruption.

        An exact completed main-workflow attempt is required. Unknown or still
        running owners stay untouched; this never changes an active pointer.
        """
        recovered=[]
        for release in self._list('/releases'):
            record=release_record(release)
            if not record or not release.get('draft') or (record['runId'],record['attempt'])==(str(owner_run),owner_attempt):continue
            try:run=self.api.request('/actions/runs/'+record['runId']+'/attempts/'+str(record['attempt']))
            except PublicError:continue
            if (run.get('status')!='completed' or run.get('head_sha')!=record['codeRevision'] or run.get('head_branch')!='main'
                    or run.get('path')!='.github/workflows/public-corpus.yml' or run.get('event') not in {'workflow_dispatch','issues'}
                    or run.get('run_attempt')!=record['attempt']):continue
            current=self._get_tag(release['tag_name'])
            if not current or not current.get('draft') or release_record(current)!=record:raise PublicError('RELEASE_RECOVERY_CHANGED','RELEASE_RECOVERY')
            expected={a['name']:a for a in record['assets']};verified=[];invalid=[]
            for asset in self.assets(release['id']):
                if asset['name']=='attempt-recovery.json':continue
                entry=expected.get(asset['name'])
                if not entry:raise PublicError('RELEASE_RECOVERY_CHANGED','RELEASE_RECOVERY')
                if self._asset_matches(asset,entry['size'],entry['sha256']):verified.append(entry)
                else:invalid.append(asset)
            report=json.dumps(dict(profile='public-attempt-v1',runId=record['runId'],attempt=record['attempt'],status='FAILED',
                                   error={'code':'RUN_INTERRUPTED','stage':'RELEASE_UPLOAD'}),sort_keys=True).encode()
            digest=hashlib.sha256(report).hexdigest()
            with tempfile.TemporaryDirectory(prefix='release-recovery-') as temporary:
                path=Path(temporary)/'attempt-recovery.json';path.write_bytes(report)
                self._upload(release['id'],path.name,path,len(report),digest)
            verified.append(dict(name='attempt-recovery.json',size=len(report),sha256=digest))
            for asset in invalid:self.api.request('/releases/assets/'+self._number(asset['id']),method='DELETE')
            failed=dict(record,status='FAILED',assets=sorted(verified,key=lambda a:a['name']),metadata={**record.get('metadata',{}),'interrupted':True})
            body=MARKER+json.dumps(failed,ensure_ascii=False,sort_keys=True)
            if len(body.encode())>120000:raise PublicError('RELEASE_RECORD_LIMIT','RELEASE_RECOVERY')
            updated=self.api.request('/releases/'+self._number(release['id']),{'body':body,'prerelease':True},'PATCH')
            self.publish(updated);recovered.append(release['id'])
        return recovered

    def retain(self, active_release_id=None, keep_attempts=2):
        """Keep recent attempt records plus the active good base, if older.

        Drafts are never deleted here: interruption recovery must reconcile them
        with the admission owner first. Failed/REUSED records count as attempts.
        """
        if type(keep_attempts) is not int or keep_attempts < 1:
            raise PublicError('RETENTION_POLICY_INVALID', 'RELEASE_RETENTION')
        releases = self._list('/releases')
        owned = [(release, release_record(release)) for release in releases]
        owned = [(r, record) for r, record in owned if record and not r.get('draft')]
        # A rerun of an older workflow ID may be the newest admitted attempt.
        owned.sort(key=lambda item: (parse_time(item[1]['createdAt']), int(item[1]['runId']), item[1]['attempt']), reverse=True)
        by_id = {r['id']: record for r, record in owned}
        if active_release_id is not None:
            if active_release_id not in by_id or by_id[active_release_id]['status'] != 'PUBLISHED':
                raise PublicError('ACTIVE_RELEASE_NOT_CONFIRMED', 'RELEASE_RETENTION')
        keep = {release['id'] for release, _ in owned[:keep_attempts]}
        if active_release_id is not None:
            keep.add(active_release_id)
        removed = []
        for release, _ in owned:
            if release['id'] in keep:
                continue
            current = self.api.request('/releases/' + self._number(release['id']))
            # Refetch ownership and inventory before destructive mutations.
            if release_record(current) != release_record(release) or current.get('draft'):
                raise PublicError('RELEASE_RETENTION_CHANGED', 'RELEASE_RETENTION')
            self._verify_tag(release['tag_name'], release_record(release)['codeRevision'], required=True)
            self.api.request('/releases/' + self._number(release['id']), method='DELETE')
            try:
                self.api.request('/git/refs/tags/' + urllib.parse.quote(release['tag_name'], safe=''), method='DELETE')
            except PublicError as error:
                if error.http_status != 404:
                    raise
            removed.append(release['id'])
        return {'retained': sorted(keep), 'deleted': removed}


def pack_runtime_state(app, names, destination):
    """Keep compiled reuse state durably; original HTTP bodies already belong
    to the source archives and are rehydrated from their verified inventory."""
    def include(relative):
        parts = relative.parts
        return (parts[0] != '.source-cache' or len(parts) >= 3
                and parts[1] in {'derived', 'models', 'validated'}
                and re.fullmatch(r'[a-f0-9]{64}\.json', parts[-1]) is not None)
    return pack_state(app, list(dict.fromkeys([*names, '.source-cache'])), destination,
                      include_file=include)


def pack_state(app, names, destination, include_file=None):
    """Package only explicitly allowed updater work directories, with hashes."""
    app, destination = Path(app), Path(destination)
    names = list(names)
    if not names or len(set(names)) != len(names) or any(name not in STATE_NAMES for name in names):
        raise PublicError('STATE_SELECTION_INVALID', 'STATE_ARCHIVE')
    if app.is_symlink() or destination.is_symlink():
        raise PublicError('STATE_PATH_INVALID', 'STATE_ARCHIVE')
    if any(destination.resolve().is_relative_to((app / name).resolve()) for name in names):
        raise PublicError('STATE_ARCHIVE_INSIDE_INPUT', 'STATE_ARCHIVE')
    entries = []
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + '.part')
    if temporary.exists() or temporary.is_symlink():
        raise PublicError('STATE_ARCHIVE_TARGET_EXISTS', 'STATE_ARCHIVE')
    try:
        with zipfile.ZipFile(temporary, 'x', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for name in sorted(names):
                root = app / name
                if root.is_symlink():
                    raise PublicError('STATE_SYMLINK_REJECTED', 'STATE_ARCHIVE')
                if not root.exists():
                    continue
                if not root.is_dir():
                    raise PublicError('STATE_DIRECTORY_INVALID', 'STATE_ARCHIVE')
                for path in sorted(root.rglob('*')):
                    if path.is_symlink():
                        raise PublicError('STATE_SYMLINK_REJECTED', 'STATE_ARCHIVE')
                    if path.is_dir():
                        continue
                    if not path.is_file():
                        raise PublicError('STATE_FILE_INVALID', 'STATE_ARCHIVE')
                    relative = path.relative_to(app).as_posix()
                    _relative(relative)
                    if include_file is not None and not include_file(PurePosixPath(relative)):
                        continue
                    size, digest = file_digest(path)
                    info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o100600 << 16
                    actual, count = hashlib.sha256(), 0
                    with path.open('rb') as source, archive.open(info, 'w', force_zip64=True) as out:
                        while chunk := source.read(BLOCK):
                            count += len(chunk)
                            actual.update(chunk)
                            out.write(chunk)
                    if count != size or actual.hexdigest() != digest:
                        raise PublicError('STATE_INPUT_CHANGED', 'STATE_ARCHIVE')
                    entries.append({'name': relative, 'size': size, 'sha256': digest})
            document = {'profile': STATE_PROFILE, 'directories': sorted(names), 'files': entries}
            archive.writestr(STATE_MANIFEST, json.dumps(document, sort_keys=True).encode())
        os.replace(temporary, destination)
        return document
    finally:
        temporary.unlink(missing_ok=True)


def restore_state(source, target, selected_names=None, optional_names=None):
    """Validate every member before moving allowed directories into the app."""
    target = Path(target)
    if target.is_symlink():
        raise PublicError('STATE_TARGET_UNSAFE', 'STATE_ARCHIVE')
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.updater-restore-', dir=target) as directory:
        stage = Path(directory)
        try:
            with zipfile.ZipFile(source) as archive:
                infos = archive.infolist()
                names = [info.filename for info in infos]
                if len(names) != len(set(names)) or STATE_MANIFEST not in names:
                    raise PublicError('STATE_ARCHIVE_INVENTORY_INVALID', 'STATE_ARCHIVE')
                manifest_info = archive.getinfo(STATE_MANIFEST)
                if manifest_info.file_size > 16_000_000:
                    raise PublicError('STATE_MANIFEST_LIMIT', 'STATE_ARCHIVE')
                manifest = json.loads(archive.read(STATE_MANIFEST))
                directories, files = manifest.get('directories'), manifest.get('files')
                if (manifest.get('profile') != STATE_PROFILE or not isinstance(directories, list)
                        or not directories or len(set(directories)) != len(directories)
                        or any(d not in STATE_NAMES for d in directories) or not isinstance(files, list)
                        or any(not isinstance(entry, dict) for entry in files)):
                    raise PublicError('STATE_ARCHIVE_INVENTORY_INVALID', 'STATE_ARCHIVE')
                selected = set(directories) if selected_names is None else set(selected_names)
                optional = set(optional_names or ())
                if not optional <= STATE_NAMES:
                    raise PublicError('STATE_SELECTION_INVALID', 'STATE_ARCHIVE')
                selected.update(name for name in optional & set(directories)
                                if not (target / name).exists() and not (target / name).is_symlink())
                if not selected <= set(directories):
                    raise PublicError('STATE_SELECTION_INVALID', 'STATE_ARCHIVE')
                if any((target / name).exists() or (target / name).is_symlink() for name in selected):
                    raise PublicError('STATE_TARGET_EXISTS', 'STATE_ARCHIVE')
                expected = [entry.get('name') for entry in files]
                if len(set(expected)) != len(expected) or sorted(names) != sorted([STATE_MANIFEST, *expected]):
                    raise PublicError('STATE_ARCHIVE_INVENTORY_INVALID', 'STATE_ARCHIVE')
                for entry in files:
                    relative = _relative(entry['name'])
                    info = archive.getinfo(entry['name'])
                    mode = info.external_attr >> 16
                    if (relative.parts[0] not in directories or len(relative.parts) < 2
                            or mode & 0o170000 not in {0, 0o100000} or info.is_dir()
                            or info.flag_bits & 1 or info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                            or type(entry.get('size')) is not int or entry['size'] < 0
                            or info.file_size != entry['size']
                            or not re.fullmatch('[a-f0-9]{64}', entry.get('sha256', ''))):
                        raise PublicError('STATE_MEMBER_INVALID', 'STATE_ARCHIVE')
                    path = stage.joinpath(*relative.parts)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    size, digest = 0, hashlib.sha256()
                    with archive.open(info) as member, path.open('xb') as out:
                        while chunk := member.read(BLOCK):
                            size += len(chunk)
                            if size > entry['size']:
                                raise PublicError('STATE_MEMBER_SIZE_MISMATCH', 'STATE_ARCHIVE')
                            digest.update(chunk)
                            out.write(chunk)
                    if size != entry['size'] or digest.hexdigest() != entry['sha256']:
                        raise PublicError('STATE_MEMBER_HASH_MISMATCH', 'STATE_ARCHIVE')
                for name in sorted(selected):
                    if (stage / name).exists():
                        os.replace(stage / name, target / name)
                return manifest
        except (zipfile.BadZipFile, json.JSONDecodeError, UnicodeDecodeError, KeyError, TypeError, ValueError):
            raise PublicError('STATE_ARCHIVE_REJECTED', 'STATE_ARCHIVE') from None
