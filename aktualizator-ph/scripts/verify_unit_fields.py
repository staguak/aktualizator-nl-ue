"""Independent XPath verification of derived unit observations; no network."""
import base64
import hashlib
import json
import re
import sys
from lxml import etree

payload = json.load(sys.stdin)
raw = base64.b64decode(payload['bytes'], validate=True)
snapshot = payload.get('snapshot') or payload['wti']
assert hashlib.sha256(raw).hexdigest() == snapshot['source']['sha256']
parser = etree.XMLParser(no_network=True, resolve_entities=False, load_dtd=False)
root = etree.fromstring(raw, parser)
assert not root.getroottree().docinfo.doctype
namespaces = {k: v for k, v in root.nsmap.items() if k}
namespaces['xml'] = 'http://www.w3.org/XML/1998/namespace'


def source_namespaces(element):
    return {**{k: v for k, v in element.nsmap.items() if k},
            'xml': 'http://www.w3.org/XML/1998/namespace'}


def expanded_attributes(attributes, element):
    bindings = source_namespaces(element)
    result = {}
    for name, value in attributes.items():
        if ':' in name:
            prefix, local = name.split(':', 1)
            name = '{' + bindings[prefix] + '}' + local
        assert name not in result
        result[name] = value
    return result

if 'wti' in payload:
    native = root.findall('.//details')
    verified_fields = 0
    assert len(native) == len(snapshot['events']), 'Incomplete WTI details'
    for element, event in zip(native, snapshot['events']):
        assert root.xpath(event['locator'], namespaces=namespaces) == [element]
        native_fields = set()
        for node in element.iter():
            if not isinstance(node.tag, str):
                continue
            native_fields.update((node, 'attribute', name) for name in node.attrib)
            children = [child for child in node if isinstance(child.tag, str)]
            own_text = ''.join(node.xpath('text()'))
            if not children and own_text.strip():
                native_fields.add((node, 'text', None))
            if children:
                native_fields.update((node, 'text', i) for i, text in enumerate(node.xpath('text()'), 1) if text.strip())
        seen = set()
        for field in event['fields']:
            text_field = re.fullmatch(r'(?:(.*)/)?text\(\)(?:\[(\d+)\])?', field['locator'])
            bindings = source_namespaces(element)
            if '/@' in field['locator']:
                targets = element.xpath(field['locator'].rsplit('/@', 1)[0], namespaces=bindings)
                if len(targets) == 1:
                    bindings.update(source_namespaces(targets[0]))
            values = element.xpath(field['locator'], namespaces=bindings)
            actual = ''.join(values) if text_field else values
            expected = field['value'] if text_field else [field['value']]
            assert actual == expected, field['locator'] + ': ' + repr(actual)[:120] + ' != ' + repr(expected)[:120]
            assert field['classification'] == 'OFFICIAL_VALUE'
            if text_field:
                node_path = text_field[1] or '.'
                nodes = element.xpath(node_path, namespaces=bindings)
                assert len(nodes) == 1
                identity = (nodes[0], 'text', int(text_field[2]) if text_field[2] else None)
            else:
                assert len(values) == 1 and getattr(values[0], 'is_attribute', False)
                identity = (values[0].getparent(), 'attribute', values[0].attrname)
            assert identity not in seen, 'Duplicate WTI field evidence'
            seen.add(identity)
        # Checking only supplied locators would miss omitted source fields.
        assert seen == native_fields, 'Incomplete WTI source fields'
        verified_fields += len(seen)
        if event['nativeLabel'] is not None:
            label = element.findall('betreft')[0]
            assert event['nativeLabel']['locator'] == ('string(betreft[1])' if any(isinstance(c.tag, str) for c in label) else 'betreft[1]/text()')
            found = element.xpath(event['nativeLabel']['locator'], namespaces=namespaces)
            assert (found if isinstance(found, str) else ''.join(found)) == event['nativeLabel']['value']
        labels = element.findall('betreft')
        assert (event['nativeLabel'] is not None) == bool(labels)
        if event['date'] is not None:
            assert root.xpath(event['date']['locator'], namespaces=namespaces) == [event['date']['value']]
        state = element.getparent()
        while state is not None and state.tag != 'datum':
            state = state.getparent()
        if state is None:
            assert event['state'] is None and event['date'] is None
        else:
            assert root.xpath(event['state']['locator'], namespaces=namespaces) == [state]
            assert expanded_attributes(event['state']['attributes'], state) == dict(state.attrib)
            assert len(event['state']['fields']) == len(state.attrib)
            assert {field['name']: field['value'] for field in event['state']['fields']} == event['state']['attributes']
            for field in event['state']['fields']:
                assert root.xpath(field['locator'], namespaces=source_namespaces(state)) == [field['value']]
            assert (event['date'] is not None) == bool(state.get('waarde'))
            if event['date'] is not None:
                assert event['date']['value'] == state.get('waarde')
                assert event['date']['semantic'] == 'WTI-datum-waarde'
        ancestor = element.getparent()
        while ancestor is not None and ancestor.tag != 'regelingelement':
            ancestor = ancestor.getparent()
        if ancestor is None:
            assert event['scope'] == 'work' and event['unitReference'] is None
        else:
            assert root.xpath(event['unitReference']['locator'], namespaces=namespaces) == [ancestor]
            assert event['unitReference']['labelId'] == ancestor.get('label-id')
            assert event['unitReference']['group'] == ancestor.get('groep')
            assert event['unitReference']['label'] == ancestor.get('label')
        assert event['legalEffect'] == 'UNRESOLVED'
    print(json.dumps({'status': 'PASS', 'wtiEvents': len(native), 'wtiFields': verified_fields}))
    raise SystemExit(0)
tags = {'artikel', 'lid', 'li', 'bijlage', 'onderdeel'} if snapshot['source']['jurisdiction'] == 'NL' else {
    'ARTICLE', 'PARAG', 'ALINEA', 'ITEM', 'ANNEX', 'POINT'}
if snapshot['source']['jurisdiction'] == 'NL' and snapshot['profile'] == 'unit-observations-v3':
    tags.update({'boek', 'deel', 'hoofdstuk', 'titeldeel', 'afdeling', 'paragraaf', 'sub-paragraaf', 'subparagraaf', 'wetgeving', 'intitule', 'citeertitel', 'aanhef', 'wetsluiting', 'regeling-sluiting', 'officiele-inhoudsopgave'})
if snapshot['profile'] == 'unit-correction-observations-v1':
    assert snapshot['source']['jurisdiction'] == 'EU' and root.tag == snapshot['root'] == 'CORR'
    tags.update({'CORR', 'CONTENTS.CORR', 'CORRECTION', 'DESCRIPTION', 'OLD.CORR', 'NEW.CORR',
                 'P', 'DLIST', 'DLIST.ITEM', 'TERM', 'DEFINITION', 'QUOT.S'})
native = [n for n in root.iter() if isinstance(n.tag, str) and n.tag in tags]
assert len(native) == len(snapshot['units']), 'Incomplete source unit traversal'
by_id = {u['technicalId']: u for u in snapshot['units']}
assert len(by_id) == len(native), 'Duplicate technical unit identity'
for element, unit in zip(native, snapshot['units']):
    found = root.xpath(unit['locator'], namespaces=namespaces)
    assert len(found) == 1 and found[0] is element, 'Unit order/locator mismatch'
    assert dict(element.attrib) == expanded_attributes(unit['attributes'], element), 'Direct attributes differ at ' + unit['locator']
    assert len(unit['fields']) == len(element.attrib)
    assert {field['name']: field['value'] for field in unit['fields']} == unit['attributes']
    assert hashlib.sha256(''.join(element.itertext()).encode()).hexdigest() == unit['text']['sha256']
    for field in unit['fields']:
        assert field['classification'] == 'OFFICIAL_VALUE'
        value = element.xpath(field['locator'], namespaces=source_namespaces(element))
        assert value == [field['value']], 'Unbacked field assertion'
    if unit['label'] is not None:
        labels = element.xpath(unit['label']['locator'], namespaces=namespaces)
        assert len(labels) == 1 and ''.join(labels[0].itertext()) == unit['label']['value']
    parent = element.getparent()
    while parent is not None and parent.tag not in tags:
        parent = parent.getparent()
    if parent is None:
        assert unit['parentId'] is None
    else:
        assert root.xpath(by_id[unit['parentId']]['locator'], namespaces=namespaces)[0] is parent
    assert unit['legalDates'] == unit['legalStatus'] == 'UNRESOLVED'
corrections = []
if snapshot['profile'] == 'unit-observations-v3':
    corrections = root.findall('.//redactionele-correctie') if snapshot['source']['jurisdiction'] == 'NL' else []
    assert len(corrections) == len(snapshot['corrections']), 'Incomplete editorial correction evidence'
    for element, correction in zip(corrections, snapshot['corrections']):
        assert correction['element'] == element.tag
        assert root.xpath(correction['locator'], namespaces=namespaces) == [element]
        assert expanded_attributes(correction['attributes'], element) == dict(element.attrib)
        assert len(correction['fields']) == len(element.attrib)
        assert {field['name']: field['value'] for field in correction['fields']} == correction['attributes']
        for field in correction['fields']:
            assert field['locator'] == '@' + field['name']
            assert element.xpath(field['locator'], namespaces=source_namespaces(element)) == [field['value']]
            assert field['classification'] == 'OFFICIAL_VALUE'
        assert correction['textSha256'] == hashlib.sha256(''.join(element.itertext()).encode()).hexdigest()
        assert correction['legalEffect'] == 'UNRESOLVED'
        matches = [unit for unit in snapshot['units'] if element.get('label-id') and
                   unit['attributes'].get('label-id') == element.get('label-id')]
        assert correction['labelMatches'] == [{'unit': unit['technicalId'], 'locator': unit['locator'] + '/@label-id'} for unit in matches]
        for key, attribute in [('old', 'oud-revisie-id'), ('new', 'nieuw-revisie-id')]:
            assert correction['revisionMatchIndexes'][key] == [i for i, unit in enumerate(matches) if
                element.get(attribute) and unit['attributes'].get('revisie-id') == element.get(attribute)]
print(json.dumps({'status': 'PASS', 'units': len(native), 'corrections': len(corrections)}))
