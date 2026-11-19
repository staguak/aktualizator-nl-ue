"""Compute source-cache signatures; GitHub manages cache retention and eviction."""
import argparse
import json
from pathlib import Path
from public_support import PublicError


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
    parser.add_argument('command', choices=['signatures'])
    parser.add_argument('--directory', default='.source-cache')
    args = parser.parse_args()
    result = {str(i): cache_signature(Path(args.directory), str(i)) for i in range(8)}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
