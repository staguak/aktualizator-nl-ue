"""Independent original-ZIP checks of Formex members, links and unit indexes."""
import hashlib
import io
import posixpath
import re
import zipfile
from lxml import etree

ROOTS = {'ACT', 'CONS.ACT', 'CONS.OTH', 'JUDGMENT', 'GENERAL', 'CORR', 'CJT', 'CASE', 'CONCLUSION'}
EXTENDED = {'JUDGMENT', 'GENERAL', 'CJT', 'CASE', 'CONCLUSION', 'ANNEX'}
BASE_UNITS = {'ARTICLE', 'PARAG', 'ALINEA', 'ITEM', 'ANNEX', 'POINT'}
EXTRA_UNITS = EXTENDED | {'CONTENTS', 'CONTENTS.JUDGMENT', 'CONTENTS.CONCLUSION', 'ENACTING.TERMS.CJT',
                         'PREAMBLE', 'SUMMARY', 'RESUME', 'GR.SEQ', 'CONSID', 'NP.ECR', 'NP', 'P',
                         'TBL', 'ROW', 'CELL', 'LIST', 'DLIST', 'DLIST.ITEM', 'TERM', 'DEFINITION', 'NOTE'}
CORR_UNITS = {'CORR', 'CONTENTS.CORR', 'CORRECTION', 'DESCRIPTION', 'OLD.CORR', 'NEW.CORR',
              'P', 'DLIST', 'DLIST.ITEM', 'TERM', 'DEFINITION', 'QUOT.S'}
CODES = {'EN': {'EN', 'ENG'}, 'PL': {'PL', 'POL'}, 'NL': {'NL', 'NLD', 'DUT'}, 'FR': {'FR', 'FRA', 'FRE'}}


def bibliography(root):
    if root.tag.startswith('CONS.'):
        return root.findall('CONS.DOC/BIB.INSTANCE')
    return [n for n in root if isinstance(n.tag, str) and n.tag.startswith('BIB.')]


def target(member, value):
    assert value and not value.startswith('/') and '\\' not in value
    result = posixpath.normpath(posixpath.join(posixpath.dirname(member), value))
    assert result != '..' and not result.startswith('../')
    return result


def resolve_formex_locator(root, locator):
    """Resolve only absolute child positions and a terminal attribute.

    The metadata is untrusted. Do not execute it as an XPath expression:
    functions, predicates other than numeric positions and descendant axes
    are not part of the locator format produced by our source parser.
    """
    if not isinstance(locator, str) or len(locator) > 4096 or not locator.startswith('/'):
        raise ValueError('Invalid Formex locator')
    steps = locator.split('/')[1:]
    if not steps or len(steps) > 128 or any(not step for step in steps):
        raise ValueError('Invalid Formex locator')
    attribute = None
    if steps[-1].startswith('@'):
        attribute = steps.pop()[1:]
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.:-]{0,127}', attribute):
            raise ValueError('Invalid Formex attribute locator')
    if not steps:
        raise ValueError('Invalid Formex locator')
    node = root
    for position, step in enumerate(steps):
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_.:-]{0,127})(?:\[([1-9][0-9]{0,8})\])?', step)
        if not match:
            raise ValueError('Invalid Formex element locator')
        name, ordinal = match.groups()
        if ':' in name:
            prefix, local = name.split(':', 1)
            namespace = node.nsmap.get(prefix)
            if not namespace:
                raise ValueError('Unknown Formex namespace prefix')
            name = '{' + namespace + '}' + local
        candidates = [node] if position == 0 else [
            child for child in node if isinstance(child.tag, str) and child.tag == name
        ]
        if position == 0:
            candidates = [candidate for candidate in candidates if candidate.tag == name]
        index = int(ordinal) if ordinal else 1
        if not candidates or index > len(candidates) or (ordinal is None and len(candidates) != 1):
            return []
        node = candidates[index - 1]
    if attribute is not None:
        return [node.attrib[attribute]] if attribute in node.attrib else []
    return [node]


def verify_formex_package(raw, metadata):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        assert len(archive.namelist()) == len(set(archive.namelist()))
        assert sorted(archive.namelist()) == metadata['members'] and archive.testzip() is None
        originals = {n: archive.read(n) for n in archive.namelist() if n.lower().endswith('.xml')}
    parser = etree.XMLParser(no_network=True, resolve_entities=False, load_dtd=False)
    xml = {name: etree.fromstring(data, parser) for name, data in originals.items()}
    assert all(not n.getroottree().docinfo.doctype for n in xml.values())
    includes = {(member, node.getroottree().getpath(node) + '/@FILEREF', 'INCLUDE', target(member, node.get('FILEREF')))
                for member, root in xml.items() for node in root.iter('INCL.ELEMENT') if node.get('TYPE') == 'FORMEX.DOC'}
    incoming = {row[3] for row in includes}
    incoming.update(target(member, n.get('FILE')) for member, root in xml.items() if root.tag == 'DOC'
                    for sub in root.iter('DOC.SUB.PUB') for n in sub.iter('REF.PHYS') if n.get('TYPE') == 'DOC.XML')
    primary = [name for name, root in xml.items() if root.tag in ROOTS and name not in incoming]
    assert primary and [d['member'] for d in metadata['documents']] == primary
    assert metadata['root'] == xml[primary[0]].tag
    doc_catalogues = {}
    for name in primary:
        refs = [target(name, n.get('FILE')) for b in bibliography(xml[name]) for n in b.findall('DOCUMENT.REF') if n.get('FILE')]
        doc_catalogues[name] = next((n for n in refs if n in xml and xml[n].tag == 'DOC'), None)
    expected_refs = set(includes)
    for name, catalogue in doc_catalogues.items():
        if catalogue:
            physical = [n for n in xml[catalogue].iter('REF.PHYS') if n.get('TYPE') == 'DOC.XML']
            assert name in {target(catalogue, n.get('FILE')) for n in physical}
            expected_refs.update((catalogue, n.getroottree().getpath(n) + '/@FILE', 'DOC', target(catalogue, n.get('FILE')))
                                 for n in physical if target(catalogue, n.get('FILE')) != name)
    components = metadata['attachments'] + metadata['fragments']
    assert len({c['member'] for c in components}) == len(components)
    assert {c['member'] for c in metadata['attachments']} == {n for n, x in xml.items() if x.tag == 'ANNEX'}
    def canonical_locator(member, locator):
        base, attribute = locator.rsplit('/@', 1)
        nodes = resolve_formex_locator(xml[member], base); assert len(nodes) == 1
        return nodes[0].getroottree().getpath(nodes[0]) + '/@' + attribute
    observed_refs = [(r['member'], canonical_locator(r['member'], r['locator']), r['kind'], c['member']) for c in components for r in c['references']]
    assert len(observed_refs) == len(set(observed_refs)) and set(observed_refs) == expected_refs
    for component in components:
        member = component['member']; root = xml[member]
        assert component['root'] == root.tag and component['sha256'] == hashlib.sha256(originals[member]).hexdigest()
        document = component['documentMember']; assert document in primary
        assert component['catalogueMember'] == doc_catalogues[document]
        first = component['references'][0]
        assert component['referenceMember'] == first['member'] and component['locator'] == first['locator']
        assert component['parentMember'] == (document if first['kind'] == 'DOC' else first['member'])
        for r in component['references']:
            values = resolve_formex_locator(xml[r['member']], r['locator'])
            assert len(values) == 1 and target(r['member'], values[0]) == member
    expected = set(primary) | {c['member'] for c in components}
    snapshots = metadata['unitHistory']
    assert len(snapshots) == len(expected) and {s['source']['member'] for s in snapshots} == expected
    position = {s['source']['member']: i + 1 for i, s in enumerate(snapshots)}
    for c in components:
        assert c['order'] == position[c['member']] and position[c['parentMember']] < position[c['member']]
    for document in metadata['documents']:
        name = document['member']; root = xml[name]
        assert document['root'] == root.tag and document['sha256'] == hashlib.sha256(originals[name]).hexdigest()
        langs = [n for b in bibliography(root) for n in b.findall('LG.DOC')]
        if langs:
            assert len(document['languageEvidence']) == len(langs)
            for evidence, node in zip(document['languageEvidence'], langs):
                assert evidence['origin'] == 'bibliography' and resolve_formex_locator(root, evidence['locator']) == [node]
                assert evidence['value'] == (node.text or '').strip().upper() and evidence['value'] in CODES[metadata['language']]
        else:
            codes = '|'.join(sorted(CODES[metadata['language']]))
            base = posixpath.basename(name)
            assert re.search(r'(?:^|[_.-]|[0-9])(?:' + codes + r')(?=[_.-]|$)', base, re.I) or re.match(r'CL[0-9]{4}[A-Z][0-9]{4}(?:' + codes + r')[0-9]', base, re.I)
            assert document['languageEvidence'] == [{'value': metadata['language'], 'origin': 'member-name', 'locator': None}]
    for snapshot in snapshots:
        name = snapshot['source']['member']; root = xml[name]
        assert snapshot['root'] == root.tag and snapshot['source']['documentId'] == metadata['celex']
        assert snapshot['source']['sha256'] == hashlib.sha256(originals[name]).hexdigest()
        assert snapshot['source']['containerSha256'] == hashlib.sha256(raw).hexdigest()
        tags = BASE_UNITS | (EXTRA_UNITS if root.tag in EXTENDED else CORR_UNITS if root.tag == 'CORR' else set())
        native = [n for n in root.iter() if isinstance(n.tag, str) and n.tag in tags]
        assert len(native) == len(snapshot['units'])
        for i, (node, unit) in enumerate(zip(native, snapshot['units'])):
            assert resolve_formex_locator(root, unit['locator']) == [node] and unit['element'] == node.tag and unit['order'] == i + 1
            assert unit['text']['sha256'] == hashlib.sha256(''.join(node.itertext()).encode()).hexdigest()
    return {'status': 'PASS', 'documents': len(primary), 'annexes': len(metadata['attachments']), 'fragments': len(metadata['fragments'])}


if __name__ == '__main__':
    import base64
    import json
    import sys
    value = json.load(sys.stdin)
    print(json.dumps(verify_formex_package(base64.b64decode(value['bytes'], validate=True), value['metadata'])))
