"""Stream frozen outputs into four verified public packages, then install."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tempfile
import zipfile

BLOCK=1024*1024


def safe(name):
    if (not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_./-]+',name)
            or any(p in {'','.','..'} for p in name.split('/')) or PurePosixPath(name).is_absolute()):
        raise ValueError('Unsafe distribution member')
    return name


def digests(stream):
    size,sha,md5=0,hashlib.sha256(),hashlib.md5()
    for chunk in iter(lambda:stream.read(BLOCK),b''):
        size+=len(chunk);sha.update(chunk);md5.update(chunk)
    return dict(bytes=size,sha256=sha.hexdigest(),md5=md5.hexdigest())


def check(actual,expected):
    for key in ['sha256','md5']:
        if key in expected and actual[key]!=expected[key]:raise ValueError('Frozen package checksum changed')
    size=expected.get('bytes',expected.get('size'))
    if size is not None and actual['bytes']!=size:raise ValueError('Frozen package size changed')


def write_member(archive,name,incoming,expected=None):
    safe(name)
    info=zipfile.ZipInfo(name,(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
    size,sha,md5=0,hashlib.sha256(),hashlib.md5()
    with archive.open(info,'w',force_zip64=True) as outgoing:
        for chunk in iter(lambda:incoming.read(BLOCK),b''):
            outgoing.write(chunk);size+=len(chunk);sha.update(chunk);md5.update(chunk)
    row=dict(name=name,bytes=size,sha256=sha.hexdigest(),md5=md5.hexdigest())
    if expected:check(row,expected)
    return row


def verified_archive(path,records):
    with zipfile.ZipFile(path) as archive:
        assert len(archive.namelist())==len(records)==len(set(archive.namelist()))
        assert set(archive.namelist())=={r['name'] for r in records}
        for row in records:
            with archive.open(row['name']) as member:check(digests(member),row)


def build(work,target,inventory,audit):
    work,target=Path(work),Path(target)
    if target.exists() or target.is_symlink():raise ValueError('Distribution target must be new')
    if json.loads(Path(audit).read_bytes()).get('status')!='PASS':raise ValueError('Independent audit required')
    frozen=json.loads(Path(inventory).read_bytes());by_module={'NL':{},'UE':{}}
    for record in frozen:
        name=safe(record['name']);module,relative=name.split('/',1)
        if module not in by_module or relative in by_module[module]:raise ValueError('Invalid frozen inventory')
        source=work/('output' if module=='NL' else 'output-ue')/relative
        if source.is_symlink() or not source.is_file():raise ValueError('Unsafe frozen file')
        with source.open('rb') as incoming:check(digests(incoming),record)
        by_module[module][relative]=record
    manifests={}
    for module,records in by_module.items():
        directory=work/('output' if module=='NL' else 'output-ue')
        paths=list(directory.rglob('*'))
        if any(p.is_symlink() for p in paths) or {p.relative_to(directory).as_posix() for p in paths if p.is_file()}!=set(records):raise ValueError('Frozen inventory is incomplete')
        manifests[module]=json.loads((directory/'manifest.json').read_bytes())
    ranges={(m['rangeFrom'],m['rangeTo']) for m in manifests.values()}
    if len(ranges)!=1:raise ValueError('Paired package date mismatch')
    target.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.distribution-',dir=target.parent) as temporary:
        stage=Path(temporary);packages=[]
        for module,manifest in manifests.items():
            directory=work/('output' if module=='NL' else 'output-ue')
            native_names={a['sourceArchive']['name'] for a in manifest['acts']}
            records=[];name=module+'-results.zip'
            with zipfile.ZipFile(stage/name,'w',allowZip64=True) as archive:
                for relative,record in sorted(by_module[module].items()):
                    if relative in native_names:continue
                    with (directory/relative).open('rb') as incoming:records.append(write_member(archive,relative,incoming,record))
            verified_archive(stage/name,records)
            source_records=[];source_name=module+'-sources.zip';catalog=[]
            with zipfile.ZipFile(stage/source_name,'w',allowZip64=True) as archive:
                for act in manifest['acts']:
                    native=act['sourceArchive'];prefix=safe(native.get('distribution',{}).get('prefix',native['name'].removesuffix('.sources.zip')))
                    if '/' in prefix:raise ValueError('Unsafe source prefix')
                    with zipfile.ZipFile(directory/native['name']) as original:
                        names=original.namelist()
                        if len(names)!=len(set(names)) or original.testzip() is not None:raise ValueError('Invalid original archive')
                        index_bytes=original.read('manifest.json');index=json.loads(index_bytes)
                        if set(names)!={'manifest.json',*[e['name'] for e in index['entries']]}:raise ValueError('Incomplete source catalog')
                        for entry in index['entries']:
                            with original.open(entry['name']) as incoming:source_records.append(write_member(archive,prefix+'/'+safe(entry['name']),incoming,entry))
                        source_records.append(write_member(archive,prefix+'/manifest.json',io.BytesIO(index_bytes)))
                        catalog.append(dict(prefix=prefix,generatedArchive=native['name'],generatedArchiveMd5=native['md5']))
                for relative,record in sorted(by_module[module].items()):
                    if relative=='IMAGE_INDEX.json' or relative.startswith('images/'):
                        with (directory/relative).open('rb') as incoming:source_records.append(write_member(archive,relative,incoming,record))
                bundle=dict(profile='public-sources-v1',jurisdiction=module,acts=catalog,files=source_records)
                raw=(json.dumps(bundle,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()
                source_records.append(write_member(archive,'BUNDLE_INDEX.json',io.BytesIO(raw)))
            verified_archive(stage/source_name,source_records)
            for file_name in [name,source_name]:
                with (stage/file_name).open('rb') as incoming:record=digests(incoming)
                packages.append(dict(name=file_name,bytes=record['bytes'],sha256=record['sha256']))
        start,end=next(iter(ranges))
        result=dict(profile='public-distribution-v1',status='PASS',rangeFrom=start,rangeTo=end,
                    counts={module:len(m['acts']) for module,m in manifests.items()},files=sorted(packages,key=lambda r:r['name']))
        (stage/'distribution.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        # The source archives are containers too: detect a replacement between
        # the initial frozen inventory check and streamed package creation.
        for module,records in by_module.items():
            directory=work/('output' if module=='NL' else 'output-ue')
            for relative,record in records.items():
                with (directory/relative).open('rb') as incoming:check(digests(incoming),record)
        stage.rename(target)
    return result


if __name__=='__main__':
    try:
        if len(sys.argv)!=5:raise ValueError('Distribution arguments invalid')
        build(*sys.argv[1:])
        print('Verified NL/UE result and original-source bundles prepared.')
    except Exception:
        print('Distribution package validation failed.',file=sys.stderr)
        raise SystemExit(1)
