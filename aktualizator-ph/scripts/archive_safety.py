"""Bounded ZIP member validation; no network or repository-specific data."""
import stat
from pathlib import PurePosixPath


def checked_members(archive):
    members = archive.infolist()
    if len(members) > 5000 or sum(m.file_size for m in members) > 1_000_000_000:
        raise RuntimeError('Artifact expansion limit exceeded')
    names = set()
    for member in members:
        name = member.filename
        parts = PurePosixPath(name).parts
        mode = member.external_attr >> 16
        if (not parts or name.startswith('/') or '\\' in name or ':' in name
                or any(p in ('..', '.') for p in parts) or name.rstrip('/') != '/'.join(parts)
                or stat.S_ISLNK(mode) or member.flag_bits & 1 or member.file_size > 256_000_000
                or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
            raise RuntimeError('Unsafe artifact member')
        canonical = '/'.join(parts)
        if canonical in names:
            raise RuntimeError('Duplicate artifact member')
        names.add(canonical)
    # Detect a file used as a directory before extracting anything.
    files = {m.filename for m in members if not m.is_dir()}
    if any('/'.join(PurePosixPath(m.filename).parts[:n]) in files
           for m in members for n in range(1, len(PurePosixPath(m.filename).parts))):
        raise RuntimeError('Conflicting artifact member paths')
    return members
