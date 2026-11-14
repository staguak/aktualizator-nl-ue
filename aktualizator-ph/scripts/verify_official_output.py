"""Independent byte/XML audit; no inference of legal validity from text dates."""
import hashlib
import io
import json
import os
from pathlib import Path
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
LANGUAGES = {'EN': ('ENG', {'en', 'eng'}), 'PL': ('POL', {'pl', 'pol'}),
             'NL': ('NLD', {'nl', 'nld', 'dut'}), 'FR': ('FRA', {'fr', 'fra', 'fre'})}


def md5(data):
    return hashlib.md5(data).hexdigest()


def audit(directory, jurisdiction):
    manifest = json.loads((directory / 'manifest.json').read_bytes())
    assert manifest['jurisdiction'] == jurisdiction
    assert manifest['officialSources']['originalBytes'] is True
    names = {'INDEX.md', 'REPORT.md', 'manifest.json'}
    summary = dict(jurisdiction=jurisdiction, acts=len(manifest['acts']),
                   sourceFiles=0, sourceBytes=0, formexPackages=0,
                   formexLayers=0, xmlFiles=0, warnings=0,
                   representationIndexes=0, formexUnavailable=0,
                   branchNotices=0, objectNotices=0)
    for act in manifest['acts']:
        files = act['files'] + [act['sourceArchive']]
        for record in files:
            assert record['name'] not in names
            names.add(record['name'])
            raw = (directory / record['name']).read_bytes()
            assert len(raw) == record['size'] and md5(raw) == record['md5']
        archive = act['sourceArchive']
        with zipfile.ZipFile(directory / archive['name']) as z:
            assert z.testzip() is None, 'ZIP CRC mismatch'
            index = json.loads(z.read('manifest.json'))
            assert index['identifier'] == act.get('bwbId', act.get('celex'))
            assert index['range']['from'] == manifest['rangeFrom']
            assert index['range']['to'] == manifest['rangeTo']
            assert len(index['entries']) == archive['entryCount']
            assert len(z.namelist()) == archive['entryCount'] + 1
            assert len(z.namelist()) == len(set(z.namelist()))
            summary['warnings'] += len(index['warnings'])
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
                    size, digest = 0, hashlib.md5()
                    with z.open(entry['name']) as incoming:
                        for chunk in iter(lambda: incoming.read(1024*1024), b''):
                            size += len(chunk);digest.update(chunk)
                    assert size == entry['size'] and digest.hexdigest() == entry['md5']
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
                assert len(data) == entry['size'] and md5(data) == entry['md5']
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
                for doc in act['documents']:
                    assert doc['language'] in LANGUAGES
                    data = html[(doc['celex'], doc['language'])]
                    # Existing view fingerprint is over decoded UTF-8 text;
                    # original byte MD5 above also includes any source BOM.
                    decoded = data.decode('utf-8-sig').encode('utf-8')
                    assert hashlib.sha256(data if doc.get('legalStructure') else decoded).hexdigest() == doc['sourceSha256']
    images = manifest.get('imagePackage')
    if images:
        assert images['profile'] == 'legal-images-v1' and images['index']['name'] == 'IMAGE_INDEX.json'
        from validate_image import inspect_image
        for record in [images['index']] + images['assets']:
            assert record['name'] not in names
            names.add(record['name'])
            raw = (directory / record['name']).read_bytes()
            assert len(raw) == record['size'] and md5(raw) == record['md5']
        image_index = json.loads((directory / 'IMAGE_INDEX.json').read_bytes())
        assert image_index['profile'] == 'legal-images-v1'
        assert {a['name'] for a in image_index['assets']} == {a['name'] for a in images['assets']}
        for asset in image_index['assets']:
            assert asset == dict(name=asset['name'], **inspect_image(directory / asset['name']))
        documents = [doc for act in manifest['acts'] for doc in (act.get('legalDocuments') or
                    [d['legalStructure'] for d in act.get('documents', []) if d.get('legalStructure')])]
        used = set()
        evidence = {source['key']: source for source in image_index['sources']}
        asset_map = {asset['name']: asset for asset in image_index['assets']}
        for occurrence in image_index['occurrences']:
            matches = [d for d in documents if (d['documentId'], d['version'], d['language']) ==
                       (occurrence['documentId'], occurrence['version'], occurrence['language'])]
            assert len(matches) == 1 and matches[0]['sourceSha256'] == occurrence['sourceSha256']
            assert any(u['id'] == occurrence['legalUnitId'] and u['sourceLocator'] == occurrence['sourceLocator'] for u in matches[0]['units'])
            assert hashlib.sha256((directory/occurrence['markdownFile']).read_bytes()).hexdigest() == occurrence['markdownSha256']
            assert occurrence['target'] in {a['name'] for a in image_index['assets']}
            if occurrence.get('sourceEvidenceKey'):
                source = evidence[occurrence['sourceEvidenceKey']]
                assert source['key'] == hashlib.sha256(source['requestUrl'].encode()).hexdigest()
                assert asset_map[occurrence['target']]['sha256'] == source['sha256']
                assert asset_map[occurrence['target']]['bytes'] == source['bytes']
            used.add(occurrence['target'])
        assert used == {a['name'] for a in image_index['assets']}
    assert not any(p.is_symlink() for p in directory.rglob('*'))
    assert {p.relative_to(directory).as_posix() for p in directory.rglob('*') if p.is_file()} == names
    summary['finalFiles'] = len(names)
    summary['range'] = [manifest['rangeFrom'], manifest['rangeTo']]
    return summary


if __name__ == '__main__':
    output_root = Path(os.environ.get('LAW_PUBLIC_WORK_ROOT', ROOT))
    results = [audit(output_root / 'output', 'NL'), audit(output_root / 'output-ue', 'EU')]
    assert results[0]['range'] == results[1]['range']
    print(json.dumps({'status': 'PASS', 'audit': 'independent byte/XML audit', 'results': results}, indent=2))
