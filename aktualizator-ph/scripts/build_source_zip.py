"""Build an immutable archive from staged files in the trusted recipe directory.

A recipe cannot select a filesystem path: source names are derived exclusively
from the sequence index and the canonical manifest basename.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import zipfile


def safe_name(name):
    return (isinstance(name, str) and bool(name) and '\\' not in name
            and '\0' not in name and not Path(name).is_absolute()
            and all(part not in {'.', '..', ''} for part in name.split('/')))


def copy_verified(archive, name, directory_fd, member, size, expected):
    if (not safe_name(name) or type(size) is not int or size < 0 or
            not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected) or
            not re.fullmatch(r'(?:input-[0-9]+|manifest\.json)', member)):
        raise ValueError('Invalid original-source archive record')
    # Resolve the fixed basename relative to a previously opened directory.
    # No source path, symlink or parent directory supplied by recipe JSON is opened.
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    descriptor = os.open(member, flags, dir_fd=directory_fd)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size != size:
            raise ValueError('Original source size or type changed')
        entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        digest = hashlib.sha256()
        total = 0
        with os.fdopen(os.dup(descriptor), 'rb') as incoming:
            with archive.open(entry, 'w', force_zip64=size >= 2**31) as outgoing:
                for chunk in iter(lambda: incoming.read(1024 * 1024), b''):
                    outgoing.write(chunk)
                    digest.update(chunk)
                    total += len(chunk)
        after = os.fstat(descriptor)
        current = os.stat(member, dir_fd=directory_fd, follow_symlinks=False)
        if (total != size or digest.hexdigest() != expected or
                (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns) !=
                (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns) or
                (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino)):
            raise ValueError('Staged source changed while archiving')
    finally:
        os.close(descriptor)


def build(recipe, recipe_path):
    directory = recipe_path.parent
    target = directory / 'source.zip'
    catalog = directory / 'manifest.json'
    if (recipe.get('target') != str(target) or
            recipe.get('catalog') != str(catalog) or
            target.is_symlink()):
        raise ValueError('Recipe may only address its own output and manifest')
    names = set()
    if not isinstance(recipe.get('files'), list):
        raise ValueError('Invalid staged inventory')
    rows = recipe['files'] + [{
        'name': 'manifest.json', 'path': str(catalog), 'size': recipe['catalogSize'],
        'sha256': recipe['catalogSha256']
    }]
    # Open the staging directory itself without following a symlink.
    directory_fd = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) |
                           getattr(os, 'O_NOFOLLOW', 0))
    try:
        # Exclusive creation: no existing output or symlink can be overwritten.
        with target.open('xb') as output:
            with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED,
                                 compresslevel=6, allowZip64=True) as archive:
                for index, row in enumerate(rows):
                    source = catalog if index == len(recipe['files']) else directory / ('input-' + str(index))
                    if row.get('path') != str(source):
                        raise ValueError('Untrusted source path in archive recipe')
                    name = row['name']
                    if name in names:
                        raise ValueError('Duplicate archive member')
                    names.add(name)
                    copy_verified(archive, name, directory_fd, source.name, row['size'], row['sha256'])
    finally:
        os.close(directory_fd)


if __name__ == '__main__':
    try:
        candidate = Path(sys.argv[1])
        if candidate.is_symlink() or not candidate.is_file():
            raise ValueError('Unsafe archive recipe')
        recipe_path = candidate.resolve(strict=True)
        build(json.loads(recipe_path.read_bytes()), recipe_path)
    except Exception:
        print('Original-source archive rejected.', file=sys.stderr)
        raise SystemExit(1)
