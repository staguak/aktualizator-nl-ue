"""Public release transfer/retention and state round trips at real boundaries."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import os
from unittest.mock import patch
from types import SimpleNamespace
from contextlib import ExitStack

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'scripts'))
from public_support import PublicError
import public_github as public
from public_releases import (ReleaseStore, MARKER, PROFILE, STATE_PROFILE, STATE_MANIFEST,
                             _ReleaseRedirect, pack_state, pack_runtime_state, restore_state)

REVISION = 'a' * 40


class FakeGitHub:
    """REST/binary service boundary; models acknowledged or lost writes."""
    repo = 'example/updater'
    _token = 'SYNTHETIC_ONLY'

    def __init__(self):
        self.releases = {}
        self.blobs = {}
        self.tags = set()
        self.tag_revisions = {}
        self.next_id = 1
        self.waits = []
        self.calls = []
        self.posts = 0
        self.lose_upload = False
        self.lose_create = False
        self.lose_publish = False

    def wait(self, seconds):
        self.waits.append(seconds)

    def request(self, route, payload=None, method='GET', attempts=3):
        self.calls.append((method, route, deepcopy(payload)))
        path = urllib.parse.urlsplit(route).path
        if path == '/releases' and method == 'GET':
            page = int(urllib.parse.parse_qs(urllib.parse.urlsplit(route).query).get('page', ['1'])[0])
            return deepcopy(list(self.releases.values())[(page - 1) * 100:page * 100])
        if path.startswith('/releases/tags/'):
            tag = urllib.parse.unquote(path[len('/releases/tags/'):])
            result = next((r for r in self.releases.values() if r['tag_name'] == tag), None)
            if result is None:
                raise PublicError('GITHUB_HTTP_404', 'GITHUB_API', 404)
            return deepcopy(result)
        if path == '/releases' and method == 'POST':
            value = dict(payload, id=self.next_id, assets=[], html_url='https://github.com/example/updater/releases/' + payload['tag_name'])
            self.releases[value['id']] = value
            self.tags.add(payload['tag_name'])
            self.tag_revisions.setdefault(payload['tag_name'], payload['target_commitish'])
            self.next_id += 1
            if self.lose_create:
                self.lose_create = False
                raise PublicError('GITHUB_NETWORK_FAILED', 'GITHUB_API')
            return deepcopy(value)
        if path.startswith('/git/refs/tags/') and method == 'DELETE':
            self.tags.remove(urllib.parse.unquote(path[len('/git/refs/tags/'):]))
            return None
        if path.startswith('/git/ref/tags/'):
            tag = urllib.parse.unquote(path[len('/git/ref/tags/'):])
            if tag not in self.tags:
                raise PublicError('GITHUB_HTTP_404', 'GITHUB_API', 404)
            return {'object': {'type': 'commit', 'sha': self.tag_revisions[tag]}}
        if path.startswith('/releases/assets/'):
            asset_id = int(path.rsplit('/', 1)[1])
            if method == 'DELETE':
                for release in self.releases.values():
                    release['assets'] = [a for a in release['assets'] if a['id'] != asset_id]
                self.blobs.pop(asset_id, None)
                return None
        if path.startswith('/releases/'):
            parts = path.split('/')
            release = self.releases.get(int(parts[2]))
            if release is None:
                raise PublicError('GITHUB_HTTP_404', 'GITHUB_API', 404)
            if len(parts) == 4 and parts[3] == 'assets':
                return deepcopy(release['assets'])
            if method == 'DELETE':
                del self.releases[release['id']]
                return None
            if method == 'PATCH':
                release.update(payload)
                if self.lose_publish:
                    self.lose_publish = False
                    raise PublicError('GITHUB_NETWORK_FAILED', 'GITHUB_API')
            return deepcopy(release)
        raise AssertionError((method, route))

    def binary(self, request, timeout):
        parsed = urllib.parse.urlsplit(request.full_url)
        if request.method == 'GET':
            return io.BytesIO(self.blobs[int(parsed.path.rsplit('/', 1)[1])])
        self.posts += 1
        self.assert_stream(request)
        content = bytearray()
        while chunk := request.data.read(64 * 1024):
            content.extend(chunk)
        name = urllib.parse.parse_qs(parsed.query)['name'][0]
        release_id = int(parsed.path.split('/')[-2])
        asset_id = max([0, *self.blobs]) + 1
        asset = {'id': asset_id, 'name': name, 'size': len(content), 'state': 'uploaded',
                 'digest': 'sha256:' + hashlib.sha256(content).hexdigest()}
        self.blobs[asset_id] = bytes(content)
        self.releases[release_id]['assets'].append(asset)
        if self.lose_upload:
            self.lose_upload = False
            raise urllib.error.URLError('SYNTHETIC_LOST_REPLY')
        return io.BytesIO(json.dumps(asset).encode())

    @staticmethod
    def assert_stream(request):
        if not hasattr(request.data, 'read') or request.get_header('Content-length') is None:
            raise AssertionError('Upload must stream an explicitly sized body')


class ReleaseTests(unittest.TestCase):
    def retention_context(self,root,store,run):
        state=root/'state';state.mkdir(exist_ok=True);control=root/'control';control.mkdir(exist_ok=True)
        (control/'admission.json').write_text(json.dumps({'accepted':True,'sha':'lease'}));(control/'result.json').write_text('{"status":"FAILED"}')
        (state/'request.json').write_text(json.dumps(dict(previousKnown=True,activeReleaseId=None,configSha256='b'*64,executionSha256='c'*64)))
        stack=ExitStack()
        for name,value in [('APP',root),('STATE',state),('CONTROL',control),('release_store',lambda:store),('state_store',lambda:SimpleNamespace(read=lambda:('lease',{'status':'RUNNING'})))]:stack.enter_context(patch.object(public,name,value))
        stack.enter_context(patch.dict(os.environ,{'GITHUB_RUN_ID':run,'GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':REVISION}))
        return stack

    def test_confirmed_no_active_base_still_keeps_only_two_failed_attempts(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);api=FakeGitHub();store=ReleaseStore(api,api.binary)
            for run in ['101','102','103']:store.record_attempt(self.directory(root),run,1,REVISION,'FAILED')
            with self.retention_context(root,store,'103'):public.retain()
            self.assertEqual({r['tag_name'] for r in api.releases.values()},{'data-102-1','data-103-1'})

    def test_bootstrap_restores_actual_failed_checkpoint_bytes_without_an_active_publication(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);source=root/'original';source.mkdir();(source/'.checkpoint').mkdir();(source/'.checkpoint/proof').write_bytes(b'original completed checkpoint')
            assets=root/'assets';assets.mkdir();pack_runtime_state(source,['.checkpoint'],assets/'runtime-state.zip')
            api=FakeGitHub();store=ReleaseStore(api,api.binary)
            store.record_attempt(assets,'101',1,REVISION,'FAILED',{'configurationSha256':'b'*64})
            target=root/'new-runner';target.mkdir();state=root/'state';state.mkdir()
            with patch.object(public,'APP',target),patch.object(public,'STATE',state),patch.object(public,'release_store',return_value=store),patch.object(public,'configuration_digest',return_value='b'*64):public.restore_runtime()
            self.assertEqual((target/'.checkpoint/proof').read_bytes(),b'original completed checkpoint')
            self.assertFalse((target/'output').exists())

    def test_workflow_recovers_an_interrupted_draft_upload_from_local_materials(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);state=root/'state';state.mkdir();directory=state/'distribution';directory.mkdir();(directory/'publication.json').write_bytes(b'fully verified data')
            api=FakeGitHub()
            def fail(request,timeout):raise urllib.error.URLError('SYNTHETIC_INTERRUPTION')
            with self.assertRaisesRegex(PublicError,'RELEASE_UPLOAD_FAILED'):ReleaseStore(api,fail).stage(directory,'101',1,REVISION)
            store=ReleaseStore(api,api.binary)
            with self.retention_context(root,store,'101'):public.retain()
            self.assertEqual(len(store.recent_attempts()),1)
            self.assertFalse(next(iter(api.releases.values()))['draft'])
            self.assertFalse((root/'control/publication.json').exists())

    def test_abandoned_owned_draft_becomes_a_failed_record_only_after_its_exact_workflow_attempt_finished(self):
        class FinishedAPI(FakeGitHub):
            finished=False
            def request(self,route,payload=None,method='GET',attempts=3):
                if route.startswith('/actions/runs/'):
                    return dict(status='completed' if self.finished else 'in_progress',head_sha=REVISION,
                                head_branch='main',path='.github/workflows/public-corpus.yml',event='workflow_dispatch',run_attempt=1)
                return super().request(route,payload,method,attempts)
        with tempfile.TemporaryDirectory() as name:
            api=FinishedAPI();store=ReleaseStore(api,api.binary);draft=store.stage(self.directory(name),'101',1,REVISION)
            self.assertEqual(store.recover_abandoned_drafts('102',1),[]);self.assertTrue(api.releases[draft['id']]['draft'])
            api.finished=True;store.recover_abandoned_drafts('102',1)
            recovered=store.recent_attempts()[0]
            from public_releases import release_record
            self.assertEqual(release_record(recovered)['status'],'FAILED');self.assertFalse(recovered['draft'])

    def directory(self, root, content=b'official output'):
        target = Path(root) / ('assets-' + str(len(list(Path(root).iterdir()))))
        target.mkdir()
        (target / 'publication.json').write_bytes(content)
        return target

    def test_draft_upload_verify_publish_and_restore_are_idempotent(self):
        with tempfile.TemporaryDirectory() as name:
            api = FakeGitHub()
            store = ReleaseStore(api, api.binary)
            directory = self.directory(name)
            draft = store.stage(directory, '101', 1, REVISION)
            self.assertTrue(draft['draft'])
            published = store.publish(draft)
            self.assertFalse(published['draft'])
            again = store.publish(store.stage(directory, '101', 1, REVISION))
            self.assertEqual(published['id'], again['id'])
            self.assertEqual(api.posts, 1)
            target = Path(name) / 'downloaded'
            record = store.restore(published['id'], target)
            self.assertEqual(record['runId'], '101')
            self.assertEqual((target / 'publication.json').read_bytes(), b'official output')
            self.assertEqual(len(api.releases), 1)

    def test_lost_create_upload_and_publish_replies_do_not_duplicate_writes(self):
        with tempfile.TemporaryDirectory() as name:
            api = FakeGitHub()
            api.lose_create = api.lose_upload = api.lose_publish = True
            store = ReleaseStore(api, api.binary)
            result = store.publish(store.stage(self.directory(name), '101', 1, REVISION))
            self.assertFalse(result['draft'])
            self.assertEqual(len(api.releases), 1)
            self.assertEqual(len(result['assets']), 1)
            self.assertEqual(api.posts, 1)

    def test_server_digest_omission_requires_download_and_corruption_is_rejected(self):
        with tempfile.TemporaryDirectory() as name:
            api = FakeGitHub()
            store = ReleaseStore(api, api.binary)
            result = store.publish(store.stage(self.directory(name), '101', 1, REVISION))
            asset = api.releases[result['id']]['assets'][0]
            del asset['digest']
            store.verify(api.releases[result['id']])
            api.blobs[asset['id']] = b'changed content'
            with self.assertRaisesRegex(PublicError, 'RELEASE_ASSET_MISMATCH'):
                store.verify(api.releases[result['id']])

    def test_failed_upload_never_publishes_or_changes_existing_good_release(self):
        with tempfile.TemporaryDirectory() as name:
            api = FakeGitHub()
            store = ReleaseStore(api, api.binary)
            good = store.publish(store.stage(self.directory(name), '101', 1, REVISION))
            before = deepcopy(api.releases[good['id']])
            def fail(request, timeout):
                raise urllib.error.URLError('SYNTHETIC_FAILURE')
            broken = ReleaseStore(api, fail)
            with self.assertRaisesRegex(PublicError, 'RELEASE_UPLOAD_FAILED'):
                broken.stage(self.directory(name), '102', 1, REVISION)
            self.assertEqual(api.releases[good['id']], before)
            self.assertEqual(sum(not r['draft'] for r in api.releases.values()), 1)

    def test_existing_foreign_release_or_mutated_inventory_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as name:
            api = FakeGitHub()
            store = ReleaseStore(api, api.binary)
            directory = self.directory(name)
            result = store.stage(directory, '101', 1, REVISION)
            api.releases[result['id']]['body'] = 'Unrelated manually created release'
            before = deepcopy(api.releases[result['id']])
            with self.assertRaisesRegex(PublicError, 'RELEASE_IDENTITY_CONFLICT'):
                store.stage(directory, '101', 1, REVISION)
            self.assertEqual(api.releases[result['id']], before)

    def test_preexisting_or_changed_tag_cannot_publish_or_delete_another_revision(self):
        with tempfile.TemporaryDirectory() as name:
            api = FakeGitHub()
            store = ReleaseStore(api, api.binary)
            api.tags.add('data-101-1')
            api.tag_revisions['data-101-1'] = 'b' * 40
            with self.assertRaisesRegex(PublicError, 'RELEASE_TAG_REVISION_MISMATCH'):
                store.stage(self.directory(name), '101', 1, REVISION)
            self.assertEqual(api.releases, {})
            good = store.record_attempt(self.directory(name), '102', 1, REVISION, 'PUBLISHED')
            api.tag_revisions[good['tag_name']] = 'c' * 40
            with self.assertRaisesRegex(PublicError, 'RELEASE_TAG_REVISION_MISMATCH'):
                store.verify(api.releases[good['id']])

    def test_two_failed_attempts_keep_older_active_base_and_remove_only_owned_history(self):
        with tempfile.TemporaryDirectory() as name:
            api = FakeGitHub()
            store = ReleaseStore(api, api.binary)
            values = []
            for run_id, status in [('100', 'PUBLISHED'), ('101', 'PUBLISHED'), ('102', 'FAILED'), ('103', 'FAILED')]:
                values.append(store.record_attempt(self.directory(name), run_id, 1, REVISION, status))
            foreign = {'id': 999, 'tag_name': 'v1.0.0', 'body': 'A software release', 'draft': False}
            api.releases[999] = foreign
            draft = store.stage(self.directory(name), '104', 1, REVISION)
            result = store.retain(active_release_id=values[1]['id'])
            self.assertEqual(result['deleted'], [values[0]['id']])
            self.assertEqual(set(result['retained']), {v['id'] for v in values[1:]})
            self.assertIn(999, api.releases)
            self.assertIn(draft['id'], api.releases)
            self.assertIn('data-101-1', api.tags)
            self.assertNotIn('data-100-1', api.tags)

    def test_rerun_chronology_and_reused_attempts_count_toward_last_two(self):
        with tempfile.TemporaryDirectory() as name:
            api = FakeGitHub()
            store = ReleaseStore(api, api.binary)
            good = store.record_attempt(self.directory(name), '100', 1, REVISION, 'PUBLISHED')
            old = store.record_attempt(self.directory(name), '101', 1, REVISION, 'REUSED')
            newer = store.record_attempt(self.directory(name), '102', 1, REVISION, 'FAILED')
            rerun = store.record_attempt(self.directory(name), '100', 2, REVISION, 'FAILED')
            result = store.retain(good['id'])
            self.assertEqual(result['deleted'], [old['id']])
            self.assertEqual(set(result['retained']), {good['id'], newer['id'], rerun['id']})
            self.assertEqual(api.releases[old['id']]['make_latest'] if old['id'] in api.releases else old['make_latest'], 'false')

    def test_unknown_active_base_blocks_all_retention_deletion(self):
        with tempfile.TemporaryDirectory() as name:
            api = FakeGitHub()
            store = ReleaseStore(api, api.binary)
            store.record_attempt(self.directory(name), '100', 1, REVISION, 'PUBLISHED')
            before = deepcopy(api.releases)
            with self.assertRaisesRegex(PublicError, 'ACTIVE_RELEASE_NOT_CONFIRMED'):
                store.retain(333)
            self.assertEqual(api.releases, before)

    def test_cross_host_redirect_strips_authorization_and_rejects_untrusted_hosts(self):
        original = urllib.request.Request('https://api.github.com/repos/example/updater/releases/assets/1',
                                          headers={'Authorization': 'Bearer SYNTHETIC'})
        handler = _ReleaseRedirect()
        redirected = handler.redirect_request(original, None, 302, 'Found', {},
                                               'https://release-assets.githubusercontent.com/path?token=synthetic')
        self.assertFalse(redirected.has_header('Authorization'))
        with self.assertRaisesRegex(PublicError, 'RELEASE_REDIRECT_REJECTED'):
            handler.redirect_request(original, None, 302, 'Found', {}, 'https://untrusted.example/asset')


class StateArchiveTests(unittest.TestCase):
    def test_real_state_archive_round_trip_preserves_original_bytes(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            app = root / 'app'
            (app / '.checkpoint/sub').mkdir(parents=True)
            (app / '.source-cache').mkdir()
            (app / '.checkpoint/sub/state.json').write_bytes(b'\xef\xbb\xbf{"original":true}\r\n')
            (app / '.source-cache/raw.bin').write_bytes(bytes(range(256)) * 17)
            archive = root / 'state.zip'
            manifest = pack_state(app, ['.checkpoint', '.source-cache'], archive)
            target = root / 'restored'
            self.assertEqual(restore_state(archive, target), manifest)
            for entry in manifest['files']:
                self.assertEqual((app / entry['name']).read_bytes(), (target / entry['name']).read_bytes())
            self.assertEqual(sorted(p.name for p in target.iterdir()), ['.checkpoint', '.source-cache'])

    def test_pack_rejects_symlinks_and_archive_inside_source(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / '.checkpoint').mkdir()
            (root / '.checkpoint/link').symlink_to(root / 'outside')
            with self.assertRaisesRegex(PublicError, 'STATE_SYMLINK_REJECTED'):
                pack_state(root, ['.checkpoint'], root / 'state.zip')
            self.assertFalse((root / 'state.zip.part').exists())
            with self.assertRaisesRegex(PublicError, 'STATE_ARCHIVE_INSIDE_INPUT'):
                pack_state(root, ['.checkpoint'], root / '.checkpoint/state.zip')

    def archive(self, path, member_name, content, expected_sha=None, mode=0o100600):
        record = {'profile': STATE_PROFILE, 'directories': ['.checkpoint'],
                  'files': [{'name': member_name, 'size': len(content),
                             'sha256': expected_sha or hashlib.sha256(content).hexdigest()}]}
        with zipfile.ZipFile(path, 'w') as archive:
            info = zipfile.ZipInfo(member_name)
            info.external_attr = mode << 16
            archive.writestr(info, content)
            archive.writestr(STATE_MANIFEST, json.dumps(record))

    def test_restore_rejects_path_escape_symlink_and_hash_mismatch_before_any_install(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            for i, args in enumerate([('../outside', b'value', None, 0o100600),
                                       ('.checkpoint/link', b'/outside', None, 0o120777),
                                       ('.checkpoint/state.json', b'modified', 'a' * 64, 0o100600)]):
                source, target = root / f'{i}.zip', root / f'target-{i}'
                self.archive(source, *args)
                with self.assertRaises(PublicError):
                    restore_state(source, target)
                self.assertEqual(list(target.iterdir()), [])
            self.assertFalse((root / 'outside').exists())

    def test_restore_refuses_to_overwrite_existing_checkpoint(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            archive, target = root / 'state.zip', root / 'app'
            self.archive(archive, '.checkpoint/state.json', b'new')
            (target / '.checkpoint').mkdir(parents=True)
            (target / '.checkpoint/state.json').write_bytes(b'existing')
            with self.assertRaisesRegex(PublicError, 'STATE_TARGET_EXISTS'):
                restore_state(archive, target)
            self.assertEqual((target / '.checkpoint/state.json').read_bytes(), b'existing')


    def test_runtime_snapshot_keeps_compiled_cache_without_duplicating_original_http_bodies(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            app, target, archive = root / 'app', root / 'restored', root / 'runtime.zip'
            for directory in ('derived', 'models', 'validated', 'http', 'blobs', 'xml-originals'):
                path = app / '.source-cache' / directory / '0'
                path.mkdir(parents=True)
                (path / ('a' * 64 + '.json')).write_text(directory)
            (app / '.source-cache/models/0/other-notes.txt').write_text('not compiled public state')
            (app / '.checkpoint').mkdir()
            (app / '.checkpoint/state.json').write_text('verified progress')
            packed = pack_runtime_state(app, ['.checkpoint'], archive)
            names = [entry['name'] for entry in packed['files']]
            for directory in ('derived', 'models', 'validated'):
                self.assertTrue(any('/' + directory + '/' in name for name in names))
            for directory in ('http', 'blobs', 'xml-originals'):
                self.assertFalse(any('/' + directory + '/' in name for name in names))
            self.assertFalse(any('other-notes' in name for name in names))
            restore_state(archive, target, selected_names={'.checkpoint'}, optional_names={'.source-cache'})
            self.assertEqual((target / '.checkpoint/state.json').read_text(), 'verified progress')
            self.assertTrue((target / '.source-cache/models/0').is_dir())

    def test_optional_restored_cache_preserves_an_existing_cache(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            app, target, archive = root / 'app', root / 'target', root / 'runtime.zip'
            (app / '.checkpoint').mkdir(parents=True)
            (app / '.checkpoint/state.json').write_text('progress')
            (target / '.source-cache').mkdir(parents=True)
            (target / '.source-cache/existing').write_text('keep existing optimization')
            pack_runtime_state(app, ['.checkpoint'], archive)
            restore_state(archive, target, selected_names={'.checkpoint'}, optional_names={'.source-cache'})
            self.assertEqual((target / '.source-cache/existing').read_text(), 'keep existing optimization')


if __name__ == '__main__':
    unittest.main()
