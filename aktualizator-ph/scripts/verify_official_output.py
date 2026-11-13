"""Independent byte/XML audit; no inference of legal validity from text dates."""
import hashlib
import io
import json
from pathlib import Path
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


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
                assert metadata['language'] == 'EN' and 0 < len(rows) < 1000
                normalized = []
                for row in rows:
                    assert row['language']['value'].endswith('/ENG')
                    normalized.append({key: row[key]['value'].replace('http:', 'https:', 1)
                                       if key != 'format' else row[key]['value']
                                       for key in ('work', 'expression', 'manifestation', 'format', 'item')
                                       if key in row})
                assert normalized == metadata['rows']
                assert {r['work'] for r in normalized} == {metadata['work']}
                representations[metadata['celex']] = normalized
                summary['representationIndexes'] += 1
                summary['formexUnavailable'] += not any(r['format'] == 'fmx4' for r in normalized)
            for entry in index['entries']:
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
                        assert languages and all(lang in ('en', 'eng') for lang in languages)
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
                    html[entry['metadata']['celex']] = data
                elif entry['name'].endswith('.fmx4.zip'):
                    summary['formexPackages'] += 1
                    # Bind a package to this document's actual manifestation,
                    # not another document in the act's archive.
                    assert entry['metadata']['language'] == 'EN'
                    celex = entry['metadata']['celex']
                    if celex in representations:
                        assert any(r['format'] == 'fmx4' and r['manifestation'] == entry['requestedUrl']
                                   for r in representations[celex])
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
                    assert doc['language'] == 'EN'
                    data = html[doc['celex']]
                    # Existing view fingerprint is over decoded UTF-8 text;
                    # original byte MD5 above also includes any source BOM.
                    decoded = data.decode('utf-8-sig').encode('utf-8')
                    assert hashlib.sha256(decoded).hexdigest() == doc['sourceSha256']
    assert {p.name for p in directory.iterdir()} == names
    summary['finalFiles'] = len(names)
    summary['range'] = [manifest['rangeFrom'], manifest['rangeTo']]
    return summary


if __name__ == '__main__':
    results = [audit(ROOT / 'output', 'NL'), audit(ROOT / 'output-ue', 'EU')]
    assert results[0]['range'] == results[1]['range']
    print(json.dumps({'status': 'PASS', 'audit': 'independent byte/XML audit', 'results': results}, indent=2))
