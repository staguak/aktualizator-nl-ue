"""Independent byte/XML audit; no inference of legal validity from text dates."""
if not __debug__:
    raise RuntimeError('Required legal-audit assertions are disabled by optimized Python')

import hashlib
import io
import json
import os
import re
from pathlib import Path
import zipfile
import xml.etree.ElementTree as ET
from verify_eu_headers import CDM
from verify_inline_images import image_source_key

ROOT = Path(__file__).resolve().parents[1]
LANGUAGES = {'EN': ('ENG', {'en', 'eng'}), 'PL': ('POL', {'pl', 'pol'}),
             'NL': ('NLD', {'nl', 'nld', 'dut'}), 'FR': ('FRA', {'fr', 'fra', 'fre'})}


def md5(data):
    return hashlib.md5(data).hexdigest()


def verify_digests(data, record):
    # MD5 is only a legacy compatibility attribute. New source evidence
    # carries a SHA-256 digest which is independently checked here.
    legacy = record.get('md5')
    strong = record.get('sha256')
    if len(data) != record['size'] or (legacy is not None and md5(data) != legacy):
        return False
    if strong is None:
        return legacy is not None
    return (isinstance(strong, str) and re.fullmatch(r'[a-f0-9]{64}', strong) is not None
            and hashlib.sha256(data).hexdigest() == strong)


def load_manifest(directory):
    manifest = json.loads((directory / 'manifest.json').read_bytes())
    files = set()
    storage = manifest.get('legalDocumentStorage')
    def resolve(ref):
        if ref.get('profile') != 'legal-document-reference-v1':
            assert storage is None, 'Mixed inline and external legal indexes'
            return ref
        assert storage == 'legal-document-files-v1'
        assert re.fullmatch(r'LEGAL_[a-f0-9]{64}\.json', ref['file'])
        assert ref['file'] == 'LEGAL_' + ref['sha256'] + '.json'
        context = ('corpus', 'documentId', 'version', 'language', 'sourceSha256')
        assert set(ref) == {'profile', 'file', 'size', 'sha256', *context}
        path = directory / ref['file']
        assert not path.is_symlink() and path.is_file()
        raw = path.read_bytes()
        assert 0 < len(raw) == ref['size'] <= 95_000_000
        assert hashlib.sha256(raw).hexdigest() == ref['sha256']
        document = json.loads(raw)
        assert document['profile'] == 'legal-structure-v1'
        assert all(document[key] == ref[key] for key in context)
        files.add(ref['file'])
        return document
    for act in manifest['acts']:
        if 'legalDocuments' in act:
            act['legalDocuments'] = [resolve(doc) for doc in act['legalDocuments']]
        for doc in act.get('documents', []):
            if 'legalStructure' in doc:
                doc['legalStructure'] = resolve(doc['legalStructure'])
    assert storage is None or storage == 'legal-document-files-v1' and files
    return manifest, files


class CachedSourceFiles:
    """Read a validated catalog and independent SHA-addressed source objects."""
    def __init__(self, catalog):
        self.catalog = catalog
        self.entries = {}
        for row in json.loads(catalog.read_bytes())['entries']:
            name, sha = row['name'], row['sha256']
            if name in self.entries or name == 'manifest.json' or not re.fullmatch('[a-f0-9]{64}', sha):
                raise ValueError('Invalid source catalog entry')
            self.entries[name] = sha

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def namelist(self):
        return ['manifest.json', *self.entries]

    def open(self, name):
        if name == 'manifest.json':
            return self.catalog.open('rb')
        sha = self.entries[name]
        root = Path(os.environ['LAW_SOURCE_CACHE_DIR'])
        path = root / 'blobs' / str(int(sha[0], 16) % 8) / (sha + '.bin')
        if any(p.is_symlink() for p in (root, path.parent.parent, path.parent, path)) or not path.is_file():
            raise ValueError('Missing or unsafe source evidence')
        return os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb')

    def read(self, name):
        with self.open(name) as stream:
            data = stream.read()
        if name != 'manifest.json' and hashlib.sha256(data).hexdigest() != self.entries[name]:
            raise ValueError('Cached source checksum mismatch')
        return data


def verify_eu_catalog_evidence(act, index, source, preference):
    if preference not in (['EN', 'FR'], ['EN', 'FR', 'NL']):
        raise ValueError('Invalid public corpus language preference')
    date_rows = set()
    territory_rows = set()
    languages_by_id = {}
    for entry in index['entries']:
        if entry['kind'] not in {'CELLAR-SPARQL', 'CELLAR-case-catalog'}:
            continue
        data = source.read(entry['name'])
        response = json.loads(data)
        source_sha = hashlib.sha256(data).hexdigest()
        for row in response.get('results', {}).get('bindings', []):
            if 'id' not in row:
                continue
            identifier = row['id']['value']
            if 'language' in row:
                languages_by_id.setdefault(identifier, set()).add(row['language']['value'])
            predicate = row.get('p', {}).get('value')
            if predicate == CDM + 'available_language':
                languages_by_id.setdefault(identifier, set()).add(row['v']['value'])
            if predicate:
                spec, work = row['v'], row.get('w', {}).get('value')
            elif 'date' in row:
                predicate = CDM + 'work_date_document'
                spec, work = row['date'], row['work']['value']
            else:
                continue
            if re.fullmatch(r'https?://publications\.europa\.eu/ontology/cdm#resource_legal_addresses_(?:country|institution)',
                            predicate):
                territory_rows.add((identifier, predicate, spec['value'], work, entry['url'], source_sha))
            if re.search('date|period|duration', predicate, re.IGNORECASE) or re.search(
                r'#(?:date|dateTime|gYear|gYearMonth|duration)$', spec.get('datatype', '')
            ):
                date_rows.add((identifier, predicate, spec['value'], spec.get('type', 'unspecified'),
                               spec.get('datatype'), spec.get('xml:lang'), work, entry['url'], source_sha))
    supported = {LANGUAGES[lang][0] for lang in preference}
    skipped = set()
    for exclusion in act.get('excludedDocuments', []):
        if exclusion['reason'] != 'SKIPPED_UNSUPPORTED_LANGUAGE':
            continue
        identifier = exclusion['celex']
        observed = languages_by_id.get(identifier, set())
        if (not observed or identifier in skipped or observed != set(exclusion['availableLanguages'])
                or exclusion['checkedLanguages'] != preference
                or any(not re.fullmatch(r'https?://publications\.europa\.eu/resource/authority/language/[A-Z]{3}', uri)
                       or uri.rsplit('/', 1)[-1] in supported for uri in observed)):
            raise ValueError('Unsupported-language exclusion lacks official proof')
        skipped.add(identifier)
    for document in act.get('documents', []):
        if document['celex'] in skipped or document['language'] not in preference:
            raise ValueError('Public EU document language differs from scope')
        dates = set()
        for observation in document.get('officialDates', []):
            scope = observation['scope']
            if scope['celex'] != document['celex']:
                raise ValueError('EU date scope differs from queried document')
            dates.add((scope['celex'], observation['predicate'], observation['originalValue'], observation['type'],
                       observation.get('datatype'), observation.get('language'), scope.get('work'),
                       observation['sourceUrl'], observation['sourceSha256']))
        if dates != {row for row in date_rows if row[0] == document['celex']} or len(dates) != len(document.get('officialDates', [])):
            raise ValueError('EU date observations differ from original queries')
        applicability = document.get('applicability', {})
        target_countries = ['NL'] if 'NL' in preference else []
        if applicability.get('checkedScope') != target_countries:
            raise ValueError('Applicability scope differs from active modules')
        observed = document.get('territorialObservations', [])
        recorded_territory = {(document['celex'], row['predicate'], row['value'], row.get('work'),
                               row['sourceUrl'], row['sourceSha256']) for row in observed}
        if (observed != applicability.get('addressedTo') or len(recorded_territory) != len(observed)
                or recorded_territory != {row for row in territory_rows if row[0] == document['celex']}):
            raise ValueError('EU addressee differs from original query')
        dutch = [row for row in observed if re.fullmatch(
            r'https?://publications\.europa\.eu/resource/authority/(?:country/NLD|fd_050/NL)', row['value'])]
        confirmed = dutch and target_countries and re.fullmatch(r'3\d{4}D\d{4}', document['celex'])
        if confirmed:
            evidence = dutch[0]
            if applicability.get('status') != 'APPLICABILITY_CONFIRMED' or applicability.get('sourceEvidence') != [
                {'scope': 'COUNTRIES', 'countries': ['NL'], 'source': evidence['sourceUrl'], 'locator': evidence['predicate']}
            ]:
                raise ValueError('Unverified decision addressee')
        elif applicability.get('status') != 'APPLICABILITY_UNKNOWN' or applicability.get('sourceEvidence') != []:
            raise ValueError('Unverified territorial applicability claim')


def audit(directory, jurisdiction):
    manifest, legal_indexes = load_manifest(directory)
    assert manifest['jurisdiction'] == jurisdiction
    assert manifest['officialSources']['originalBytes'] is True
    names = {'INDEX.md', 'REPORT.md', 'manifest.json'} | legal_indexes
    summary = dict(jurisdiction=jurisdiction, acts=len(manifest['acts']),
                   sourceFiles=0, sourceBytes=0, formexPackages=0,
                   formexLayers=0, xmlFiles=0, warnings=0,
                   representationIndexes=0, formexUnavailable=0,
                   branchNotices=0, objectNotices=0, unresolvedSources=0)
    for act in manifest['acts']:
        files = act['files'] + [act['sourceArchive']]
        for record in files:
            assert record['name'] not in names
            names.add(record['name'])
            raw = (directory / record['name']).read_bytes()
            assert verify_digests(raw, record)
        archive = act['sourceArchive']
        source_path = directory / archive['name']
        source = CachedSourceFiles(source_path) if source_path.suffix == '.json' else zipfile.ZipFile(source_path)
        with source as z:
            if isinstance(z, zipfile.ZipFile):
                assert z.testzip() is None, 'ZIP CRC mismatch'
            index = json.loads(z.read('manifest.json'))
            discovery_failures = [e for e in index['entries'] if e['kind'] in {'CELLAR-discovery-unavailable','CELLAR-case-discovery-unavailable'}]
            if act.get('discoveryIncomplete'):
                assert discovery_failures
                for entry in discovery_failures:
                    code = 'DISCOVERY_UNAVAILABLE' if entry['kind']=='CELLAR-discovery-unavailable' else 'CASE_DISCOVERY_UNAVAILABLE'
                    if code=='DISCOVERY_UNAVAILABLE':assert index['discovery']['unavailable'] is True
                    proof = json.loads(z.read(entry['name']))
                    assert proof['profile'] == 'eu-discovery-unavailable-v1' and proof['celex'] == index['identifier']
                    assert any(i['code'] == code and i['classification'] == 'SOURCE_UNAVAILABLE' for i in index['sourceIssues'])
            else:
                assert not discovery_failures
            if jurisdiction == 'EU' and source_path.suffix == '.json':
                verify_eu_catalog_evidence(act, index, z, manifest['languagePreference'])
            missing = act.get('missingDocuments', [])
            assert len({m['celex'] for m in missing}) == len(missing)
            failures = [e for e in index['entries'] if e['kind'] == 'CELLAR-document-unavailable']
            assert len(failures) == len(missing)
            for m in missing:
                assert m['profile'] == 'eu-document-unavailable-v1' and m['document']['celex'] == m['celex']
                preferred = manifest.get('languagePreference', ['EN','PL','NL','FR'])
                advertised = m['document']['metadata'].get('available_language', [])
                supported = [lang for lang in preferred if any(uri.endswith('/'+LANGUAGES[lang][0]) for uri in advertised)]
                assert [a['language'] for a in m['attempts']] == (supported or preferred) and all(a['reason'] for a in m['attempts'])
                assert not any(d['celex'] == m['celex'] for d in act.get('documents', []))
                matches = [e for e in failures if e['metadata']['celex'] == m['celex']]
                assert len(matches) == 1 and json.loads(z.read(matches[0]['name'])) == m
                assert any(i['code'] == 'DOCUMENT_UNAVAILABLE' and i['documentId'] == m['celex'] and i['classification'] == 'SOURCE_UNAVAILABLE' for i in index['sourceIssues'])
            assert index['identifier'] == act.get('bwbId', act.get('celex'))
            assert index['range']['from'] == manifest['rangeFrom']
            assert index['range']['to'] == manifest['rangeTo']
            assert len(index['entries']) == archive['entryCount']
            assert len(z.namelist()) == archive['entryCount'] + 1
            assert len(z.namelist()) == len(set(z.namelist()))
            summary['warnings'] += len(index['warnings'])
            if source_path.suffix == '.json':
                summary['unresolvedSources'] += sum(
                    issue['classification'] in {'SOURCE_UNAVAILABLE', 'REPRESENTATION_REJECTED', 'HISTORY_INCOMPLETE', 'CRITICAL'}
                    or issue['code'] in {'WEMI_INDEX_UNAVAILABLE', 'RDF_NOTICE_UNAVAILABLE', 'FORMEX_LOCATION_FAILED'}
                    for issue in index.get('sourceIssues', []))
            states = set()
            html = {}
            representations = {}
            for entry in index['entries']:
                if entry['kind'] != 'CELLAR-WEMI-index':
                    continue
                rows = json.loads(z.read(entry['name']))['results']['bindings']
                metadata = entry['metadata']
                assert metadata['language'] in LANGUAGES and 0 < len(rows) < 1000
                normalized = []
                for row in rows:
                    assert row['language']['value'].endswith('/'+LANGUAGES[metadata['language']][0])
                    normalized.append({key: row[key]['value'].replace('http:', 'https:', 1)
                                       if key != 'format' else row[key]['value']
                                       for key in ('work', 'expression', 'manifestation', 'format', 'item')
                                       if key in row})
                assert normalized == metadata['rows']
                assert {r['work'] for r in normalized} == {metadata['work']}
                identity = (metadata['celex'], metadata['language'])
                assert identity not in representations, 'Duplicate document/language representation index'
                representations[identity] = normalized
                summary['representationIndexes'] += 1
                summary['formexUnavailable'] += not any(r['format'] == 'fmx4' for r in normalized)
            for entry in index['entries']:
                if entry['kind'].startswith('CELLAR-RDF'):
                    # Large RDF is streamed without a bytes object or DOM.
                    # SHA-256 is the sole integrity authority for large
                    # streamed RDF; MD5 stays in the catalog for compatibility.
                    size, digest = 0, hashlib.sha256()
                    with z.open(entry['name']) as incoming:
                        for chunk in iter(lambda: incoming.read(1024*1024), b''):
                            size += len(chunk);digest.update(chunk)
                    strong = entry.get('sha256')
                    assert (size == entry['size'] and isinstance(strong, str)
                            and re.fullmatch(r'[a-f0-9]{64}', strong)
                            and digest.hexdigest() == strong)
                    with z.open(entry['name']) as incoming:
                        stack = []
                        for event, element in ET.iterparse(incoming, events=('start','end')):
                            if event == 'start':
                                if not stack:assert element.tag.rsplit('}',1)[-1] == 'RDF'
                                stack.append(element)
                            else:
                                stack.pop();element.clear()
                                if stack:stack[-1].remove(element)
                    summary['sourceFiles'] += 1;summary['sourceBytes'] += size;summary['xmlFiles'] += 1
                    summary['objectNotices'] += entry['kind'] == 'CELLAR-RDF-object'
                    continue
                data = z.read(entry['name'])
                assert verify_digests(data, entry)
                summary['sourceFiles'] += 1
                summary['sourceBytes'] += len(data)
                if entry['name'].endswith('.xml'):
                    xml = ET.fromstring(data)
                    summary['xmlFiles'] += 1
                    if entry['kind'] == 'CELLAR-XML-branch':
                        assert xml.tag == 'NOTICE' and xml.attrib['type'] == 'branch'
                        assert xml.find('WORK') is not None
                        languages = [el.text for el in xml.findall('EXPRESSION/LANG/VALUE')]
                        language = entry['metadata']['language']
                        assert language in LANGUAGES and languages and all(lang in LANGUAGES[language][1] for lang in languages)
                        summary['branchNotices'] += 1
                    if entry['kind'] == 'CELLAR-RDF-object':
                        summary['objectNotices'] += 1
                    if entry['kind'] == 'BWB-Toestand':
                        assert xml.attrib.get('bwb-id') == act['bwbId']
                        states.add(entry['metadata']['version']['key'])
                        tags = ('artikel', 'lid', 'li', 'bijlage', 'onderdeel') if entry['metadata'].get('unitHistoryProfile') == 'unit-observations-v2' else ('artikel', 'lid', 'li', 'bijlage')
                        if entry['metadata'].get('unitHistoryProfile') == 'unit-observations-v3':
                            tags = ('artikel', 'lid', 'li', 'bijlage', 'onderdeel', 'boek', 'deel', 'hoofdstuk', 'titeldeel', 'afdeling', 'paragraaf', 'sub-paragraaf', 'subparagraaf', 'wetgeving', 'intitule', 'citeertitel', 'aanhef', 'wetsluiting', 'regeling-sluiting', 'officiele-inhoudsopgave')
                        units = [el for el in xml.iter() if el.tag in tags]
                        assert len(units) == len(entry['metadata']['units'])
                elif entry['name'].endswith('.xhtml'):
                    identity = (entry['metadata']['celex'], entry['metadata']['language'])
                    assert identity not in html, 'Duplicate original text'
                    html[identity] = data
                elif entry['name'].endswith('.fmx4.zip'):
                    summary['formexPackages'] += 1
                    from verify_formex_package import verify_formex_package
                    verify_formex_package(data, entry['metadata'])
                    # Bind a package to this document's actual manifestation,
                    # not another document in the act's archive.
                    assert entry['metadata']['language'] in LANGUAGES
                    celex = entry['metadata']['celex']
                    identity = (celex, entry['metadata']['language'])
                    if identity in representations:
                        assert any(r['format'] == 'fmx4' and r['manifestation'] == entry['requestedUrl']
                                   for r in representations[identity])
                    with zipfile.ZipFile(io.BytesIO(data)) as package:
                        assert package.testzip() is None
                        assert len(package.namelist()) == len(set(package.namelist()))
                        assert sorted(package.namelist()) == entry['metadata']['members']
                        layers = []
                        for member in package.namelist():
                            if not member.endswith('.xml'):
                                continue
                            root = ET.fromstring(package.read(member))
                            layers.extend(dict(el.attrib) for el in root.iter('INFO.CONSLEG'))
                        assert layers == entry['metadata']['layers']
                        summary['formexLayers'] += len(layers)
            if jurisdiction == 'NL':
                assert states == {state['key'] for state in act['sourceStates']}
            else:
                from verify_eu_headers import verify_header
                header_responses=[(entry['kind'],z.read(entry['name'])) for entry in index['entries'] if entry['kind'] in {'CELLAR-SPARQL','CELLAR-case-catalog'} and not (entry['kind']=='CELLAR-SPARQL' and index.get('discovery',{}).get('unavailable'))]
                for doc in act['documents']:
                    assert doc['language'] in LANGUAGES
                    data = html[(doc['celex'], doc['language'])]
                    # Existing view fingerprint is over decoded UTF-8 text;
                    # original byte MD5 above also includes any source BOM.
                    decoded = data.decode('utf-8-sig').encode('utf-8')
                    assert hashlib.sha256(data if doc.get('legalStructure') else decoded).hexdigest() == doc['sourceSha256']
                    if doc.get('legalStructure'):
                        source=[e for e in index['entries'] if e['kind']=='CELLAR-XHTML' and e['metadata']['celex']==doc['celex']]
                        assert len(source)==1
                        verify_header(directory,doc,data,source[0]['url'],header_responses,[f for f in act['files'] if f['celex']==doc['celex']])
    images = manifest.get('imagePackage')
    if images:
        assert images['profile'] in {'legal-images-v1', 'legal-images-v2'} and images['index']['name'] == 'IMAGE_INDEX.json'
        from validate_image import inspect_image
        for record in [images['index']] + images['assets']:
            assert record['name'] not in names
            names.add(record['name'])
            raw = (directory / record['name']).read_bytes()
            assert verify_digests(raw, record)
        image_index = json.loads((directory / 'IMAGE_INDEX.json').read_bytes())
        assert image_index['profile'] == images['profile']
        assert {a['name'] for a in image_index['assets']} == {a['name'] for a in images['assets']}
        for asset in image_index['assets']:
            assert asset == dict(name=asset['name'], **inspect_image(directory / asset['name']))
        documents = [doc for act in manifest['acts'] for doc in (act.get('legalDocuments') or
                    [d['legalStructure'] for d in act.get('documents', []) if d.get('legalStructure')])]
        from verify_inline_images import audit_inline
        canonical = audit_inline(directory, image_index, documents)
        assert images.get('rendering') == image_index.get('rendering', {}).get('profile')
        if images.get('rendering'):
            assert images['legalOffsetScope'] == 'restored-canonical-body'
            assert images['unavailableImages'] == len(image_index.get('unavailableImages', []))
            assert not any(f.get('kind') == 'reference' for a in manifest['acts'] for f in a['files'])
        used = set()
        evidence = {source['key']: source for source in image_index['sources']}
        asset_map = {asset['name']: asset for asset in image_index['assets']}
        def context(occurrence):
            matches = [d for d in documents if (d['documentId'], d['version'], d['language']) ==
                       (occurrence['documentId'], occurrence['version'], occurrence['language']) and
                       any(p['file'] == occurrence['markdownFile'] for p in d['parts'])]
            assert matches and all(d['sourceSha256'] == occurrence['sourceSha256'] for d in matches)
            assert all(any(u['id'] == occurrence['legalUnitId'] and u['sourceLocator'] == occurrence['sourceLocator'] for u in d['units']) for d in matches)
            raw = canonical.get(occurrence['markdownFile'])
            raw = raw.encode() if raw is not None else (directory/occurrence['markdownFile']).read_bytes()
            assert hashlib.sha256(raw).hexdigest() == occurrence['markdownSha256']
            return matches[0]
        for occurrence in image_index.get('omittedDecorations', []) + image_index.get('unavailableImages', []):
            doc = context(occurrence)
            if occurrence['reason'] == 'decorative-european-flag':
                units = {u['id']: u for u in doc['units']}
                assert all(units[k]['kind'] in {'version','image','table','other'} for k in occurrence['contextIds'])
        for occurrence in image_index['occurrences']:
            context(occurrence)
            assert occurrence['target'] in {a['name'] for a in image_index['assets']}
            if occurrence.get('sourceEvidenceKey'):
                source = evidence[occurrence['sourceEvidenceKey']]
                assert source['key'] == image_source_key(source, image_index['profile'])
                if source.get('baseUrl'):assert source['baseUrl']==occurrence['sourceUrl']
                assert asset_map[occurrence['target']]['sha256'] == source['sha256']
                assert asset_map[occurrence['target']]['bytes'] == source['bytes']
                if source.get('resolution'):
                    import base64
                    proof = source['resolution']
                    original = base64.b64decode(proof['sourceDocumentBase64'], validate=True)
                    assert hashlib.sha256(original).hexdigest() == proof['sourceSha256']
                    assert proof['documentId'] == occurrence['documentId'] and proof['version'] == occurrence['version']
                    assert proof['language'] in {'EN','PL','NL','FR'} and proof['attempts'][-1]['language'] == proof['language'] and proof['attempts'][-1]['outcome'] == 'AVAILABLE'
            used.add(occurrence['target'])
        assert used == {a['name'] for a in image_index['assets']}
    assert not any(p.is_symlink() for p in directory.rglob('*'))
    assert {p.relative_to(directory).as_posix() for p in directory.rglob('*') if p.is_file()} == names
    summary['finalFiles'] = len(names)
    summary['range'] = [manifest['rangeFrom'], manifest['rangeTo']]
    summary['missingDocuments'] = sum(len(a.get('missingDocuments', [])) for a in manifest['acts'])
    summary['unavailableImages'] = (manifest.get('imagePackage') or {}).get('unavailableImages', 0)
    summary['incompleteCatalogs'] = sum(bool(a.get('discoveryIncomplete')) for a in manifest['acts'])
    if jurisdiction == 'EU':
        documents = [doc for act in manifest['acts'] for doc in act.get('documents', [])]
        unknown = sum(doc.get('applicability', {}).get('status') == 'APPLICABILITY_UNKNOWN' for doc in documents)
        summary['territorialApplicabilityCoverage'] = {'documents': len(documents), 'unknown': unknown,
                                                       'confirmed': sum(doc.get('applicability', {}).get('status') == 'APPLICABILITY_CONFIRMED' for doc in documents)}
        summary['languageCoverage'] = {'retained': len(documents),
                                       'skippedUnsupported': sum(row['reason'] == 'SKIPPED_UNSUPPORTED_LANGUAGE'
                                           for act in manifest['acts'] for row in act.get('excludedDocuments', []))}
    summary['completeness'] = 'PARTIAL' if summary['missingDocuments'] or summary['unavailableImages'] or summary['incompleteCatalogs'] or summary['unresolvedSources'] else 'COMPLETE'
    return summary


if __name__ == '__main__':
    output_root = Path(os.environ.get('LAW_PUBLIC_WORK_ROOT', ROOT))
    results = [audit(output_root / 'output', 'NL'), audit(output_root / 'output-ue', 'EU')]
    assert results[0]['range'] == results[1]['range']
    print(json.dumps({'status': 'PASS', 'audit': 'independent byte/XML audit', 'results': results}, indent=2))
