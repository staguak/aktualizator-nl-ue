"""Create a canonical archive while retaining original source bytes on disk."""
import hashlib
import json
from pathlib import Path
import stat
import sys
import zipfile


def safe_name(name):
    p = Path(name)
    return bool(name) and not p.is_absolute() and '..' not in p.parts and '\\' not in name


def build(recipe):
    names = set()
    with zipfile.ZipFile(recipe['target'], 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        rows = recipe['files'] + [dict(name='manifest.json', path=recipe['catalog'])]
        for row in rows:
            name, source = row['name'], Path(row['path'])
            if not safe_name(name) or name in names or source.is_symlink() or not stat.S_ISREG(source.stat().st_mode):
                raise ValueError('Invalid source archive member')
            names.add(name)
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            size, digest = 0, hashlib.sha256()
            with source.open('rb') as incoming, archive.open(entry, 'w', force_zip64=source.stat().st_size >= 2**31) as outgoing:
                for chunk in iter(lambda: incoming.read(1024*1024), b''):
                    outgoing.write(chunk);digest.update(chunk);size += len(chunk)
            if 'size' in row and size != row['size'] or row.get('sha256') and digest.hexdigest() != row['sha256']:
                raise ValueError('Source changed while archiving')


if __name__ == '__main__':
    try:
        build(json.loads(Path(sys.argv[1]).read_bytes()))
    except Exception:
        print('Original-source archive rejected.', file=sys.stderr)
        raise SystemExit(1)
