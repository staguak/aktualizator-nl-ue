"""Assemble and verify the cumulative, file-based public corpus."""
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
import zipfile

from archive_safety import checked_members
from verify_official_output import load_manifest, verify_digests

PROFILE = 'public-nl-eu-corpus-v2'
MODULES = ('NL', 'UE')
OUTPUTS = {'NL': 'output', 'UE': 'output-ue'}
CONTROL_FILES = {'INDEX.md', 'REPORT.md', 'manifest.json'}
EVIDENCE_SPLIT = 45_000_000
EVIDENCE_PROFILE = 'public-source-evidence-v1'
SHA = re.compile('[a-f0-9]{64}')


def canonical(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_file(path):
    return json.loads(path.read_bytes())


def files_at(directory, prefix=''):
    return {prefix + p.relative_to(directory).as_posix(): p for p in directory.rglob('*') if p.is_file()}


def hashes(files):
    rows = []
    for name, path in sorted(files.items()):
        if path.is_symlink():
            raise ValueError('Corpus file must be regular')
        data = path.read_bytes()
        rows.append({'name': name, 'bytes': len(data), 'sha256': digest(data)})
    return rows


def audit_pair(audit, target):
    if audit.get('status') != 'PASS':
        raise ValueError('Independent audit required')
    results = {r['jurisdiction']: r for r in audit.get('results', [])}
    if len(audit.get('results', [])) != 2 or set(results) != {'NL', 'EU'} or any(
        row.get('completeness') != 'COMPLETE' or row.get('range', [None, None])[1] != target
        or any(row.get(key) for key in ('missingDocuments', 'unavailableImages', 'incompleteCatalogs', 'unresolvedSources'))
        for row in results.values()
    ):
        raise ValueError('Paired audit incomplete or inconsistent')


def verified_phase(outputs, proof, target):
    frozen = json_file(proof)
    audit_pair(frozen['audit'], target)
    files = {name: file for module, directory in outputs.items()
             for name, file in files_at(directory, module + '/').items()}
    if hashes(files) != sorted(frozen['files'], key=lambda row: row['name']):
        raise ValueError('Public payload changed after validation')
    return frozen['audit']


def read_legacy_catalog(directory, record, cache=None):
    archive_path = directory / record['name']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+\.sources\.zip', archive_path.name):
        raise ValueError('Unexpected legacy archive name')
    if not verify_digests(archive_path.read_bytes(), record):
        raise ValueError('Legacy archive checksum mismatch')
    with zipfile.ZipFile(archive_path) as archive:
        members = {member.filename for member in checked_members(archive) if not member.is_dir()}
        catalog = json.loads(archive.read('manifest.json'))
        entries = catalog['entries']
        expected = {row['name'] for row in entries}
        if len(entries) != len(expected) or members != expected | {'manifest.json'}:
            raise ValueError('Legacy source inventory mismatch')
        if cache is not None:
            for row in entries:
                body = archive.read(row['name'])
                if not verify_digests(body, row):
                    raise ValueError('Legacy source member checksum mismatch')
                sha = digest(body)
                row['sha256'] = sha
                folder = cache / 'blobs' / str(int(sha[0], 16) % 8)
                if any(p.is_symlink() for p in (cache, folder.parent, folder)):
                    raise ValueError('Unsafe source cache')
                folder.mkdir(parents=True, exist_ok=True)
                target = folder / (sha + '.bin')
                if target.is_symlink():
                    raise ValueError('Unsafe legacy source object')
                if not target.is_file() or digest(target.read_bytes()) != sha:
                    with tempfile.NamedTemporaryFile(dir=folder, delete_on_close=False) as stage:
                        stage.write(body)
                        stage.close()
                        Path(stage.name).replace(target)
    return catalog


def read_catalog(directory, act):
    record = act.get('sourceArchive', {})
    if record.get('name', '').endswith('.sources.zip'):
        return read_legacy_catalog(directory, record)
    if re.fullmatch(r'[A-Za-z0-9_.-]+\.sources\.json', record.get('name', '')):
        catalog = json_file(directory / record['name'])
        for entry in catalog['entries']:
            if entry['kind'] == 'BWB-WTI' and 'metadataRef' in entry:
                entry['metadata'] = json.loads(read_evidence(directory, entry['metadataRef']))
        return catalog
    return {}


def eu_legal_metadata(doc):
    fields = {key: value for key, value in doc['metadata'].items()
              if re.search('date|validity|in-force|period|applicab|correct|repeal|amend|annul|territor|address', key)}
    flags = doc['metadata'].get('_dp', '')
    if 'i' in flags:
        fields['resource_legal_in-force'] = ['1']
    if 'e' in flags:
        fields['resource_legal_date_end-of-validity'] = ['9999-12-31']
    if 'd' in doc['metadata'].get('_aliases', ''):
        fields['work_date_document'] = fields['act_consolidated_date']
    return fields


def nl_effect_dates(directory, act):
    by_version = {}
    for ref in act.get('legalDocuments', []):
        document = json_file(directory / ref['file']) if ref.get('profile') == 'legal-document-reference-v1' else ref
        grouped = {}
        for unit in document.get('units', []):
            for predicate, value in unit.get('attributes', {}).items():
                if predicate in {'inwerkingtredingsdatum', 'vervaldatum'}:
                    grouped.setdefault(predicate, set()).add(value)
        by_version[document['version']] = {key: sorted(values) for key, values in grouped.items()}
    return by_version


def graphic_facts(directory):
    path = directory / 'IMAGE_INDEX.json'
    if not path.is_file():
        return {}
    index = json_file(path)
    assets = {asset['name']: asset['sha256'] for asset in index['assets']}
    observed = {}
    for occurrence in index['occurrences']:
        key = canonical([occurrence[field] for field in ('documentId', 'version', 'language', 'sourceLocator', 'kind')])
        observed.setdefault('image:' + digest(key), set()).add(assets[occurrence['target']])
    return {key: {'dates': {}, 'assetSha256': sorted(values)} for key, values in observed.items()}


def legal_facts(directory, module):
    manifest = json_file(directory / 'manifest.json')
    facts = graphic_facts(directory)
    for act in manifest['acts']:
        catalog = read_catalog(directory, act)
        if module == 'NL':
            effects = nl_effect_dates(directory, act)
            states = {e['name']: e.get('sha256') for e in catalog.get('entries', []) if e['kind'] == 'BWB-Toestand'}
            for state in act.get('sourceStates', []):
                identifier = state['key']
                facts[f'{act["bwbId"]}/{identifier}'] = {
                    'dates': {key: state.get(key) for key in ('validFrom', 'validTo')},
                    'source': states.get(f'toestand/{identifier}.xml'),
                    'effectDates': effects.get(identifier, {}),
                }
            for entry in catalog.get('entries', []):
                if entry['kind'] == 'BWB-WTI' and entry.get('metadata', {}).get('wtiHistory'):
                    facts[f'{act["bwbId"]}/WTI'] = {'dates': {'events': entry['metadata']['wtiHistory']['events']}}
            continue
        for doc in act.get('documents', []):
            status = doc.get('applicability', {})
            fact = {'dates': eu_legal_metadata(doc), 'source': doc.get('sourceSha256'),
                    'text': doc.get('inputBodyHash')}
            if status.get('status') == 'APPLICABILITY_CONFIRMED':
                fact['scope'] = [sorted(row.get('countries', [])) for row in status.get('sourceEvidence', [])]
            facts[f'{act["celex"]}/{doc["celex"]}/{doc["language"]}'] = fact
    return facts


def dated_transitions(facts, old_to, new_to):
    def crossed(text):
        if not isinstance(text, str):
            return False
        try:
            value = date.fromisoformat(text)
        except ValueError:
            return False
        return old_to < value <= new_to
    legal_predicates = {'validFrom', 'validTo', 'inwerkingtredingsdatum', 'vervaldatum'}
    return sum(any(crossed(value) for key, values in {**fact['dates'], **fact.get('effectDates', {})}.items()
                   if key in legal_predicates or re.search('entry-into-force|start-of-validity|end-of-validity|application', key)
                   for value in (values if isinstance(values, list) else [values]))
               for fact in facts.values())


def compare(previous, update):
    """Count observed changes to legal facts and dated transitions."""
    counts = {}
    for module, directory in update.items():
        before = legal_facts(previous[module], module)
        after = legal_facts(directory, module)
        def changed(key, fact):
            if key not in before:
                return True
            old = before[key]
            if key.startswith('image:'):
                return fact['assetSha256'] != old['assetSha256']
            if fact['dates'] != old['dates'] or fact.get('scope') != old.get('scope'):
                return True
            if module == 'NL':
                return bool(fact.get('source') and old.get('source') and fact['source'] != old['source'])
            return fact.get('source') != old.get('source') and fact.get('text') != old.get('text')
        old_to = date.fromisoformat(json_file(previous[module] / 'manifest.json')['rangeTo'])
        new_to = date.fromisoformat(json_file(directory / 'manifest.json')['rangeTo'])
        if new_to < old_to:
            raise ValueError('Candidate ends before the active corpus')
        counts[module] = sum(changed(key, value) for key, value in after.items()) + dated_transitions(after, old_to, new_to)
    return counts


def stable_catalog(catalog):
    catalog.pop('range', None)
    def strip(value):
        if isinstance(value, dict):
            return {key: strip(item) for key, item in value.items()
                    if key not in {'xmlValidation', 'retrievedAt', 'observedAt', 'checkedAt', 'generatedAt'}}
        if isinstance(value, list):
            return [strip(item) for item in value]
        return value
    catalog = strip(catalog)
    for row in catalog['entries']:
        observed = row.pop('httpObservation', None)
        hint = row.pop('cacheHint', None)
        if observed and hint and hint.get('url') == row['requestedUrl']:
            row['verificationRequest'] = {'headers': hint['headers']}
        elif observed:
            row['verificationRequest'] = None
    return canonical(catalog)


def public_catalog(catalog, save):
    data = stable_catalog(catalog)
    if len(data) <= EVIDENCE_SPLIT:
        return data
    value = json.loads(data)

    def externalize(payload):
        body = canonical(payload)
        sha = digest(body)
        name = f'evidence/{sha}.json'
        save(name, body)
        return {'profile': EVIDENCE_PROFILE, 'name': name, 'sha256': sha, 'bytes': len(body)}

    # Original response boundaries supply independent metadata files. Source
    # identities, dates carried directly by the manifest and request hints stay
    # discoverable without loading the full BWB unit history.
    for entry in value['entries']:
        if 'metadata' in entry:
            entry['metadataRef'] = externalize(entry.pop('metadata'))
    if 'unitHistory' in value:
        history = value.pop('unitHistory')
        value['unitHistoryRefs'] = {key: externalize(item) for key, item in history.items()}
    return canonical(value)


def read_evidence(directory, ref):
    sha = ref.get('sha256', '')
    name = ref.get('name')
    if ref.get('profile') != EVIDENCE_PROFILE or not SHA.fullmatch(sha) or name != f'evidence/{sha}.json':
        raise ValueError('Invalid source evidence reference')
    target = directory / name
    if target.is_symlink() or not target.is_file():
        raise ValueError('Source evidence object is unavailable')
    data = target.read_bytes()
    if len(data) != ref['bytes'] or digest(data) != sha:
        raise ValueError('Source evidence checksum mismatch')
    return data


def install_evidence(target, name, data):
    destination = target / name
    destination.parent.mkdir(exist_ok=True)
    if not destination.exists():
        destination.write_bytes(data)
    elif destination.read_bytes() != data:
        raise ValueError('Source evidence identity conflict')


def clean_manifest(manifest, directory, target):
    manifest.pop('generatedAt', None)
    sources = manifest.get('officialSources', {})
    sources.pop('observedOn', None)
    sources.pop('xmlValidation', None)
    for act in manifest['acts']:
        record = act.get('sourceArchive', {})
        name = record.get('name')
        if not name:
            continue
        if record.get('distribution'):
            record.pop('distribution')
        if name.endswith('.json'):
            data = public_catalog(json_file(directory / name),
                                  lambda object_name, body: install_evidence(target, object_name, body))
            (target / name).write_bytes(data)
            record.update(size=len(data), md5=hashlib.md5(data).hexdigest(), sha256=digest(data))
            record.pop('reportEvidence', None)
    return manifest


def install_current(directory, target):
    target.mkdir(parents=True)
    for name, source in files_at(directory).items():
        if name in CONTROL_FILES or name.endswith('.sources.json'):
            continue
        if name.endswith('.zip'):
            raise ValueError('New corpus must use separate source files')
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    manifest = clean_manifest(json_file(directory / 'manifest.json'), directory, target)
    (target / 'manifest.json').write_bytes(canonical(manifest))
    # Catalog digests here refer to the stable public catalogs, not run receipts.
    index = (directory / 'INDEX.md').read_text()
    for old in json_file(directory / 'manifest.json')['acts']:
        record = old.get('sourceArchive')
        if record:
            index = index.replace('MD5 ' + record['md5'], 'SHA-256 ' + digest((target / record['name']).read_bytes()))
    (target / 'INDEX.md').write_text(index, encoding='utf-8')
    (target / 'REPORT.md').write_text(
        '# Zweryfikowany korpus\n\n[Indeks danych](manifest.json) · [Audyt](../VERIFICATION.json)\n',
        encoding='utf-8')
    return manifest


def history_rows(directory):
    index = directory / 'history.json'
    return json_file(index)['snapshots'] if index.is_file() else []


def history_payload(directory, cache=None):
    """All legal output and manifests, with technical source receipts removed."""
    manifest = json_file(directory / 'manifest.json')
    payload = {name: path.read_bytes() for name, path in files_at(directory).items()
               if name not in CONTROL_FILES and name != 'history.json'
               and not name.startswith('history/') and not name.endswith(('.sources.zip', '.sources.json'))}
    # The original catalog linkage stays traceable even if source cache expires.
    manifest.pop('generatedAt', None)
    manifest.get('officialSources', {}).pop('observedOn', None)
    manifest.get('officialSources', {}).pop('xmlValidation', None)
    for act in manifest['acts']:
        record = act.get('sourceArchive')
        if record:
            record.pop('reportEvidence', None)
            if record['name'].endswith('.json'):
                catalog = stable_catalog(json_file(directory / record['name']))
                payload[record['name']] = catalog
                record.update(size=len(catalog), md5=hashlib.md5(catalog).hexdigest(), sha256=digest(catalog))
            else:
                original = record.copy()
                old_name = original['name']
                catalog = public_catalog(read_legacy_catalog(directory, original, cache),
                                         lambda name, body: payload.setdefault(name, body))
                name = old_name.removesuffix('.zip') + '.json'
                payload[name] = catalog
                record.update(name=name, size=len(catalog), md5=hashlib.md5(catalog).hexdigest(), sha256=digest(catalog),
                              legacyArchiveSha256=original.get('sha256') or digest((directory / old_name).read_bytes()))
                record.pop('distribution', None)
    payload['manifest.json'] = canonical(manifest)
    return payload


def merge_history(target, predecessors, cache):
    existing = {row['sha256']: row['name'] for row in hashes(files_at(target))}
    snapshots = {}

    def install(checksum, name, data=None, source=None):
        if checksum not in existing:
            suffix = Path(name).suffix
            if suffix not in {'.md', '.json', '.jpg', '.png', '.svg', '.webp', '.gif'}:
                suffix = '.bin'
            filename = f'history/{checksum}{suffix}'
            path = target / filename
            path.parent.mkdir(exist_ok=True)
            if source is None:
                path.write_bytes(data)
            else:
                shutil.copyfile(source, path)
            existing[checksum] = filename
        return {'path': existing[checksum], 'sha256': checksum}

    for predecessor in predecessors:
        known = files_at(predecessor)
        for snapshot in history_rows(predecessor):
            if snapshot['id'] in snapshots:
                continue
            records = {}
            for name, ref in snapshot['files'].items():
                source = known.get(ref['path'])
                if source is None:
                    raise ValueError('Unknown historical file path')
                checksum = ref['sha256']
                if digest(source.read_bytes()) != checksum:
                    raise ValueError('Prior history hash mismatch')
                records[name] = install(checksum, name, source=source)
            snapshots[snapshot['id']] = records
        payload = history_payload(predecessor, cache)
        digests = {name: digest(data) for name, data in payload.items()}
        identifier = digest(canonical(digests))
        snapshots[identifier] = {name: install(digests[name], name, data=body)
                                 for name, body in sorted(payload.items())}
    if snapshots:
        rows = [{'id': identifier, 'files': files} for identifier, files in sorted(snapshots.items())]
        (target / 'history.json').write_bytes(canonical({'profile': 'legal-history-v1', 'snapshots': rows}))
        with (target / 'INDEX.md').open('a', encoding='utf-8') as index:
            index.write('\n[Zachowane wersje i relacje historyczne](history.json).\n')


def check_current(directory, rows):
    inventory = {row['name']: row for row in rows}
    for module in MODULES:
        target = directory / module
        manifest, indexes = load_manifest(target)
        expected = set(CONTROL_FILES) | indexes
        for act in manifest['acts']:
            records = act['files'] + [act['sourceArchive']]
            for record in records:
                name = record['name']
                row = inventory.get(module + '/' + name)
                if name in expected or not row or row['bytes'] != record['size']:
                    raise ValueError('Invalid current corpus reference')
                strong = record.get('sha256')
                if strong and row['sha256'] != strong:
                    raise ValueError('Current corpus source catalog checksum mismatch')
                if not verify_digests((target / name).read_bytes(), record):
                    raise ValueError('Current corpus file checksum mismatch')
                expected.add(name)
                if record is act['sourceArchive']:
                    catalog = json_file(target / name)
                    refs = [e['metadataRef'] for e in catalog['entries'] if 'metadataRef' in e]
                    refs.extend(catalog.get('unitHistoryRefs', {}).values())
                    for ref in refs:
                        if ref['name'] not in expected:
                            read_evidence(target, ref)
                            expected.add(ref['name'])
        image_package = manifest.get('imagePackage', {})
        for record in ([image_package['index'], *image_package['assets']] if image_package else []):
            name = record['name']
            if name in expected or not re.fullmatch(r'IMAGE_INDEX\.json|images/[a-f0-9]{64}\.[a-z0-9]+', name):
                raise ValueError('Invalid current image reference')
            if not verify_digests((target / name).read_bytes(), record):
                raise ValueError('Current image checksum mismatch')
            expected.add(name)
        actual = {name.split('/', 1)[1] for name in inventory
                  if name.startswith(module + '/') and not name.startswith(module + '/history/')
                  and name != module + '/history.json'}
        if expected != actual:
            raise ValueError('Current corpus inventory disagrees with manifest')


def check_history(directory, rows):
    available = {row['name']: row['sha256'] for row in rows}
    for module in MODULES:
        reached = set()
        for snapshot in history_rows(directory / module):
            digests = {}
            for name, ref in snapshot['files'].items():
                path = module + '/' + ref['path']
                if available.get(path) != ref['sha256']:
                    raise ValueError('History references missing or modified data')
                digests[name] = ref['sha256']
                if ref['path'].startswith('history/'):
                    if Path(ref['path']).stem != ref['sha256']:
                        raise ValueError('Invalid history object name')
                    reached.add(path)
            if 'manifest.json' not in digests or digest(canonical(digests)) != snapshot['id']:
                raise ValueError('History record identity mismatch')
            def read_file(name):
                ref = snapshot['files'].get(name)
                if ref is None:
                    raise ValueError('Historical manifest references missing file')
                return (directory / module / ref['path']).read_bytes()

            manifest = json.loads(read_file('manifest.json'))
            if manifest.get('jurisdiction') != ('NL' if module == 'NL' else 'EU'):
                raise ValueError('Historical module identity mismatch')
            for act in manifest['acts']:
                for record in act['files'] + [act['sourceArchive']]:
                    if not verify_digests(read_file(record['name']), record):
                        raise ValueError('Historical law or source catalog checksum mismatch')
                for doc in act.get('legalDocuments', []) + [
                    doc['legalStructure'] for doc in act.get('documents', []) if 'legalStructure' in doc
                ]:
                    if doc.get('profile') == 'legal-document-reference-v1':
                        raw = read_file(doc['file'])
                        if digest(raw) != doc['sha256'] or len(raw) != doc['size']:
                            raise ValueError('Historical unit index checksum mismatch')
                for record in act['files']:
                    if record.get('canonicalFile') and record['canonicalFile'] not in digests:
                        raise ValueError('Historical canonical text is missing')
            if manifest.get('imagePackage'):
                package = manifest['imagePackage']
                for record in [package['index'], *package['assets']]:
                    if not verify_digests(read_file(record['name']), record):
                        raise ValueError('Historical graphic checksum mismatch')
        if reached != {path for path in available if path.startswith(module + '/history/')}:
            raise ValueError('Unindexed history objects')


def folder_sizes(rows):
    return {module: sum(row['bytes'] for row in rows if row['name'].startswith(module + '/'))
            for module in MODULES}


def require_monotonic(before, after):
    for module in MODULES:
        if after[module] < before[module]:
            raise ValueError(f'Corpus folder shrank after merge: {module} {before[module]} -> {after[module]}')


def assemble(destination, update, prior, base, cache=None):
    destination.mkdir()
    manifests = {}
    for module in MODULES:
        target = destination / module
        manifests[module] = install_current(update[module], target)
        merge_history(target, [pair[module] for pair in (prior, base) if pair], cache)
    return manifests
