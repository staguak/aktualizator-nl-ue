"""Bounded cache housekeeping; required publication/state is never cache."""
import argparse
import json
import os
from pathlib import Path
import stat
import time
from public_support import GitHubApi, PublicError

HIGH = 7_000_000_000
LOW = 4_000_000_000
PREFIX = 'nl-ue-source-v5-'


def prune_local(directory, high=HIGH, low=LOW):
    root = Path(directory)
    if root.is_symlink():
        raise PublicError('CACHE_PATH_INVALID', 'CACHE_CLEANUP')
    entries = []
    if root.exists():
        for path in root.rglob('*'):
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise PublicError('CACHE_PATH_INVALID', 'CACHE_CLEANUP')
            if stat.S_ISREG(info.st_mode):
                entries.append((info.st_mtime_ns, path.as_posix(), info.st_size, path))
    before = sum(row[2] for row in entries)
    remaining = before
    deleted = []
    if before > high:
        for _, name, size, path in sorted(entries):
            path.unlink()
            remaining -= size
            deleted.append(name)
            if remaining <= low:
                break
    return dict(beforeBytes=before, afterBytes=remaining, removedBytes=before-remaining,
                deleted=deleted, policy='above-7GB-to-at-most-4GB')


def prune_remote(api, high=HIGH, low=LOW):
    entries = []
    for page in range(1, 101):
        data = api.request('/actions/caches?per_page=100&page=' + str(page))
        batch = data.get('actions_caches', [])
        entries.extend(row for row in batch if row.get('key', '').startswith(PREFIX))
        if len(batch) < 100:
            break
    else:
        raise PublicError('CACHE_PAGINATION_LIMIT', 'CACHE_CLEANUP')
    before = sum(int(row['size_in_bytes']) for row in entries)
    remaining, deleted = before, []
    if before > high:
        for row in sorted(entries, key=lambda r: (r['created_at'], r['id'])):
            try:
                api.request('/actions/caches/' + str(row['id']), method='DELETE')
            except PublicError as error:
                if error.http_status != 404:
                    raise
            remaining -= int(row['size_in_bytes'])
            deleted.append(row['id'])
            if remaining <= low:
                break
    return dict(beforeBytes=before, afterBytes=remaining, removedBytes=before-remaining,
                deleted=deleted, policy='above-7GB-to-at-most-4GB')


def cache_signature(root, shard):
    import hashlib
    value = hashlib.sha256()
    for directory in (Path(root) / name / shard for name in ('http', 'blobs', 'derived', 'models', 'validated')):
        if directory.exists():
            for path in sorted(directory.rglob('*')):
                if path.is_symlink():
                    raise PublicError('CACHE_PATH_INVALID', 'CACHE_CLEANUP')
                if path.is_file():
                    value.update(path.relative_to(root).as_posix().encode())
                    with path.open('rb') as stream:
                        for chunk in iter(lambda: stream.read(1024*1024), b''):
                            value.update(chunk)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['local', 'remote', 'signatures'])
    parser.add_argument('--directory', default='.source-cache')
    args = parser.parse_args()
    if args.command == 'local':
        result = prune_local(args.directory)
    elif args.command == 'remote':
        result = prune_remote(GitHubApi(os.environ['GITHUB_REPOSITORY'], os.environ['GH_TOKEN']))
    else:
        result = {str(i): cache_signature(Path(args.directory), str(i)) for i in range(8)}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
