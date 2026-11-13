"""Bounded local ZIP packaging/extraction; never follows symlinks."""
import sys
from pathlib import Path
import os
import zipfile
import shutil
import stat
from archive_safety import checked_members


def pack(target, paths, allow_missing=False):
    requested = [Path(p).absolute() for p in paths]
    missing = [p for p in requested if not p.exists()]
    if missing and not allow_missing:
        raise ValueError('Required evidence input missing')
    roots = [p for p in requested if p.exists()]
    if not roots:
        raise ValueError('No evidence files')
    # Layout depends on the declared inputs, not which optional files survived.
    base = requested[0] if len(requested) == 1 and requested[0].is_dir() else Path(os.path.commonpath([str(p.parent) for p in requested]))
    files = set()
    for root in roots:
        if any(p.is_symlink() for p in [root, *root.parents]):
            raise ValueError('Symlink evidence refused')
        for file in ([root] if root.is_file() else root.rglob('*')):
            if file.is_symlink():
                raise ValueError('Symlink evidence refused')
            if file.is_file():
                files.add(file)
            elif not file.is_dir():
                raise ValueError('Non-regular evidence input')
    if not files:
        raise ValueError('No evidence files')
    if len(files) > 5000 or sum(f.stat().st_size for f in files) > 1_000_000_000:
        raise ValueError('Evidence expansion limit')
    with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(files):
            if file.stat().st_size > 256_000_000:
                raise ValueError('Evidence member limit')
            info = zipfile.ZipInfo(file.relative_to(base).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            # Do not bind immutable retry bytes to filesystem timestamps.
            with file.open('rb') as source, archive.open(info, 'w') as output:
                shutil.copyfileobj(source, output)
    with zipfile.ZipFile(target) as archive:
        checked_members(archive)
        if archive.testzip() is not None:
            raise ValueError('Packed evidence CRC mismatch')
    return {'profile': 'evidence-input-inventory-v1', 'requested': [str(p.relative_to(base)) for p in requested],
            'missing': [str(p.relative_to(base)) for p in missing], 'files': len(files), 'partial': bool(missing)}


def unpack(source, destination):
    destination = Path(destination).absolute()
    if destination.exists() or any(p.is_symlink() for p in [destination, *destination.parents]):
        raise ValueError('New non-symlink destination required')
    with zipfile.ZipFile(source) as archive:
        members = checked_members(archive)
        if archive.testzip() is not None:
            raise ValueError('ZIP CRC mismatch')
        destination.mkdir(parents=True)
        archive.extractall(destination, members)


if __name__ == '__main__':
    if sys.argv[1] == 'pack':
        import json
        args = sys.argv[3:]
        print(json.dumps(pack(sys.argv[2], [a for a in args if a != '--allow-missing'], '--allow-missing' in args)))
    elif sys.argv[1] == 'unpack':
        unpack(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit('pack NEW_ZIP PATH... | unpack ZIP NEW_DIRECTORY')
