"""Pinned, offline XML/XSD validation. Never rewrites official source bytes."""
import argparse
import sys
import re
import hashlib
import io
import json
from pathlib import Path
from urllib.parse import urljoin, urlsplit, unquote
import zipfile
from lxml import etree
import rdflib
import pyparsing
from rdflib import Graph, URIRef, Literal, BNode
from rdflib.exceptions import ParserError
from xml.sax import SAXParseException

XSI = '{http://www.w3.org/2001/XMLSchema-instance}'
CATALOG_SHA256 = '5a3292345fb2c9771ef088a9852bac247c2c63f4514222a897225b13e7b3879d'
PROFILE = 'official-xml-v2-rdf3:' + CATALOG_SHA256
RDF_PROFILE = 'cellar-rdf-graph-v2:rdflib-7.6.0'
MAX_XML_BYTES = 64_000_000
MAX_RDF_TRIPLES = 250_000
MAX_RDF_FACTS = 5_000


class RejectedRdf(ValueError):
    pass


class BoundedRdfGraph(Graph):
    def add(self, triple):
        # Enforce before allocating the next distinct statement. Checking only
        # len(graph) after parsing allows a hostile graph to exhaust memory first.
        if len(self) >= MAX_RDF_TRIPLES and triple not in self:
            raise RejectedRdf('RDF graph resource limit exceeded')
        return super().add(triple)


def validate_rdf_graph(raw, source_url, identifier=None):
    # Called only after safe XML/DTD validation. Passing bytes with an explicit
    # format never dereferences owl:sameAs, imports, ontology or source URLs.
    rdflib.NORMALIZE_LITERALS = False
    try:
        graph = BoundedRdfGraph().parse(data=raw, format='xml', publicID=source_url or 'urn:nl-eu-updater:rdf-source')
    except (ParserError, SAXParseException) as error:
        raise RejectedRdf('Invalid RDF/XML graph grammar') from error
    if len(graph) > MAX_RDF_TRIPLES:
        raise RejectedRdf('RDF graph resource limit exceeded')
    cdm = 'http://publications.europa.eu/ontology/cdm#'
    ids = URIRef(cdm + 'resource_legal_id_celex')
    works = {s for s, _, o in graph.triples((None, ids, None))
             if isinstance(o, Literal) and str(o) == identifier} if identifier else set()
    if identifier and not works:
        raise RejectedRdf('Requested CELEX absent from RDF graph')
    def transport_identity(value):
        parsed = urlsplit(str(value))
        # Official RDF keeps HTTP URIs; transport uses HTTPS for the same
        # Publications Office resource. Preserve original terms in the facts.
        if parsed.hostname == 'publications.europa.eu' and parsed.path.startswith('/resource/'):
            return 'https://publications.europa.eu' + unquote(parsed.path).split('/rdf/')[0]
        return str(value).split('/rdf/')[0]
    aliases = {}
    for subject, _, value in graph.triples((None, URIRef('http://www.w3.org/2002/07/owl#sameAs'), None)):
        if isinstance(subject, URIRef) and isinstance(value, URIRef):
            a, b = transport_identity(subject), transport_identity(value)
            aliases.setdefault(a, set()).add(b)
            aliases.setdefault(b, set()).add(a)
    reachable = {transport_identity(source_url)}
    pending = list(reachable)
    while pending:
        current = pending.pop()
        for alias in aliases.get(current, set()) - reachable:
            reachable.add(alias)
            pending.append(alias)
        if len(reachable) > 256:
            raise RejectedRdf('Ambiguous RDF resource identity closure')
    if identifier and not any(transport_identity(work) in reachable for work in works):
        raise RejectedRdf('Requested CELEX is unrelated to the returned RDF resource')
    facts, opaque = [], 0
    # A second subject can repeat the same CELEX without being an alias of the
    # returned work. Its dates must not enter that work's selected assertions.
    selected = {work for work in works if transport_identity(work) in reachable}
    unrelated = sorted(str(work) for work in works - selected if isinstance(work, URIRef))
    if len(unrelated) > MAX_RDF_FACTS:
        raise RejectedRdf('RDF identity assertion resource limit exceeded')
    for subject, predicate, value in graph:
        if isinstance(value, Literal) and getattr(value, 'ill_typed', False):
            raise RejectedRdf('Ill-typed RDF literal')
        if subject not in selected or not str(predicate).startswith(cdm):
            continue
        local = str(predicate)[len(cdm):]
        if not re.search('date|in.force|amend|modif|correct|repeal|annul|consolidat|id_celex', local):
            continue
        if isinstance(subject, BNode) or isinstance(value, BNode):
            opaque += 1
            continue
        term = dict(type='literal' if isinstance(value, Literal) else 'uri', value=str(value))
        if isinstance(value, Literal):
            term.update(datatype=str(value.datatype) if value.datatype else None, language=value.language)
        if len(facts) >= MAX_RDF_FACTS:
            raise RejectedRdf('RDF assertion resource limit exceeded')
        facts.append(dict(subject=str(subject), predicate=str(predicate), object=term,
                          classification='OFFICIAL_VALUE', locator='RDF subject/predicate/object'))
    facts.sort(key=lambda item: json.dumps(item, sort_keys=True))
    if len(facts) > MAX_RDF_FACTS:
        raise RejectedRdf('RDF assertion resource limit exceeded')
    values = {}
    for fact in facts:
        values.setdefault((fact['subject'], fact['predicate']), []).append(fact['object'])
    multiple = [dict(subject=s, predicate=p, values=v, status='MULTIPLE_VALUES_UNRESOLVED')
                for (s, p), v in sorted(values.items()) if len(v) > 1]
    return dict(profile=RDF_PROFILE, status='PASS', triples=len(graph),
                identity='CONFIRMED' if works else 'NOT_CHECKED', requestedCelex=identifier,
                unrelatedCelexSubjects=unrelated,
                opaqueUnrelatedCelexSubjects=sum(isinstance(work, BNode) for work in works - selected),
                identityScope='Returned resource and explicit owl:sameAs aliases; no legal-effect inference',
                facts=facts, multipleValues=multiple, opaqueAssertions=opaque,
                scope='RDF grammar, typed literals and direct selected-work CDM assertions; '
                      'no ontology closure, inferred legal effects or complete legal history')


def checked_zip(raw, limit=256_000_000):
    z = zipfile.ZipFile(io.BytesIO(raw))
    names = z.namelist()
    if len(names) != len(set(names)) or sum(i.file_size for i in z.infolist()) > limit:
        raise ValueError('Duplicate or oversized ZIP entries')
    if any(n.startswith('/') or any(p in ('', '.', '..') for p in n.split('/')) for n in names):
        raise ValueError('Unsafe ZIP path')
    if z.testzip() is not None:
        raise ValueError('ZIP CRC mismatch')
    return z



class DenyExternal(etree.Resolver):
    def resolve(self, url, public_id, context):
        raise ValueError('External XML resource resolution is forbidden')


def safe_parser(resolver=None):
    parser = etree.XMLParser(no_network=True, resolve_entities=False, load_dtd=False,
                             recover=False, huge_tree=False)
    parser.resolvers.add(resolver or DenyExternal())
    return parser


def assert_source_identity(doc, kind, identifier):
    local, namespace = etree.QName(doc).localname, etree.QName(doc).namespace
    nl = {'BWB-Toestand': ('toestand', 'bwb-id'),
          'BWB-WTI': ('wetstechnische-informatie', 'bwb-id'),
          'BWB-manifest': ('work', 'label')}
    if kind in nl:
        root, field = nl[kind]
        if namespace or local != root or not re.fullmatch(r'BWBR[0-9]{7}', identifier or '') or doc.get(field) != identifier:
            raise ValueError('BWB source identity mismatch')
    elif kind == 'SRU-2.0':
        if (namespace, local) != ('http://docs.oasis-open.org/ns/search-ws/sruResponse', 'searchRetrieveResponse'):
            raise ValueError('SRU source root mismatch')
    elif kind == 'CELLAR-Formex4':
        pass  # The pinned Formex schema validates its root; layer/language checks follow separately.
    elif kind in ('CELLAR-RDF-tree', 'CELLAR-RDF-object'):
        if (namespace, local) != ('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'RDF'):
            raise ValueError('RDF/XML source root mismatch')
    elif kind == 'CELLAR-XML-branch':
        if namespace or local != 'NOTICE':
            raise ValueError('CELLAR branch source root mismatch')
    else:
        raise ValueError('Unsupported XML representation')


def schema_matches_kind(url, kind):
    if kind == 'BWB-Toestand':
        return '/Schema/BWB-toestand/' in url and url.rsplit('/', 1)[-1].startswith('toestand_')
    if kind == 'BWB-WTI':
        return '/Schema/BWB-WTI/' in url and url.rsplit('/', 1)[-1].startswith('wti_')
    if kind == 'BWB-manifest':
        return url.endswith('/_manifest.xsd') or '/_schemas/_manifest_' in url
    if kind == 'SRU-2.0':
        return url.endswith('/searchRetrieve/v1.0/os/schemas/sruResponse.xsd')
    if kind == 'CELLAR-Formex4':
        return 'formex' in url.lower()
    return False  # RDF/branch have no pinned XSD; never call their structural check XSD PASS.


class PinnedSchemas:
    def __init__(self, directory):
        catalog_bytes = (directory / 'catalog.json').read_bytes()
        if hashlib.sha256(catalog_bytes).hexdigest() != CATALOG_SHA256:
            raise ValueError('Schema catalog digest mismatch')
        catalog = json.loads(catalog_bytes)
        raw = (directory / 'official-schemas.zip').read_bytes()
        if hashlib.sha256(raw).hexdigest() != catalog['bundleSha256']:
            raise ValueError('Schema bundle digest mismatch')
        self.entries, self.bytes, self.compiled = {}, {}, {}
        self.bundle_sha256 = catalog['bundleSha256']
        self.catalog_sha256 = CATALOG_SHA256
        with checked_zip(raw, 16_000_000) as z:
            if set(z.namelist()) != {e['file'] for e in catalog['entries']}:
                raise ValueError('Schema bundle inventory mismatch')
            for entry in catalog['entries']:
                data = z.read(entry['file'])
                if hashlib.sha256(data).hexdigest() != entry['sha256']:
                    raise ValueError('Original schema digest mismatch')
                self.bytes[entry['file']] = data
                for url in (entry['url'], entry['fetchUrl'], *entry.get('aliases', [])):
                    if url in self.entries and self.entries[url]['sha256'] != entry['sha256']:
                        raise ValueError('Conflicting schema URL')
                    self.entries[url] = entry
        owner = self

        class Resolver(etree.Resolver):
            def resolve(self, url, public_id, context):
                if url not in owner.entries:
                    raise ValueError('Unpinned schema resolution: ' + url)
                entry = owner.entries[url]
                return self.resolve_string(owner.bytes[entry['file']], context,
                                           base_url=entry['fetchUrl'])

        for entry in catalog['entries']:
            parser = safe_parser(Resolver())
            doc = etree.fromstring(self.bytes[entry['file']], parser, base_url=entry['fetchUrl'])
            if entry.get('dependencyAssembly'):
                # Preserve original XSD bytes. The assembly supplies only exact
                # pinned namespace dependencies whose original URI has whitespace.
                xs = '{http://www.w3.org/2001/XMLSchema}'
                originals = [(e.get('namespace'), e.get('schemaLocation'))
                             for e in doc.findall(xs + 'import')]
                dependencies = entry['dependencyAssembly']
                if originals != [(d['namespace'], d['sourceLocation']) for d in dependencies]:
                    raise ValueError('Dependency assembly does not match original imports')
                wrapper = etree.Element(xs + 'schema', nsmap={'xs': xs[1:-1]},
                                        targetNamespace=doc.get('targetNamespace'))
                for dependency in dependencies:
                    target = self.entries.get(dependency['url'])
                    if not target:
                        raise ValueError('Unpinned dependency assembly target')
                    imported = etree.fromstring(self.bytes[target['file']], parser)
                    if imported.get('targetNamespace') != dependency['namespace']:
                        raise ValueError('Dependency namespace mismatch')
                    etree.SubElement(wrapper, xs + 'import', namespace=dependency['namespace'],
                                     schemaLocation=dependency['url'])
                etree.SubElement(wrapper, xs + 'include', schemaLocation=entry['url'])
                doc = etree.fromstring(etree.tostring(wrapper), parser,
                                       base_url='urn:nl-eu-updater:research:assembly:' + entry['sha256'])
            schema = etree.XMLSchema(doc)
            for url in (entry['url'], entry['fetchUrl'], *entry.get('aliases', [])):
                self.compiled[url] = schema

    def validate(self, raw, source_url, kind=None, identifier=None):
        parser = safe_parser()
        if not raw or len(raw) > MAX_XML_BYTES:
            raise ValueError('Invalid XML payload size')
        doc = etree.fromstring(raw, parser)
        if doc.getroottree().docinfo.doctype:
            raise ValueError('DTD is not permitted by the official XML validation profile')
        namespace = etree.QName(doc).namespace
        local = etree.QName(doc).localname
        if kind:
            assert_source_identity(doc, kind, identifier)
        location = None
        if namespace:
            pairs = doc.get(XSI + 'schemaLocation', '').split()
            if len(pairs) % 2:
                raise ValueError('Invalid namespace/schema location pairs')
            locations = [pairs[i + 1] for i in range(0, len(pairs), 2) if pairs[i] == namespace]
            if len(locations) > 1:
                raise ValueError('Ambiguous root namespace schema location')
            location = locations[0] if locations else None
        else:
            location = doc.get(XSI + 'noNamespaceSchemaLocation')
        if location and not location.startswith(('https:', 'http:')):
            location = urljoin(source_url, location)
        if not location or location not in self.compiled:
            return {'status': 'NO_PINNED_SCHEMA', 'root': local, 'namespace': namespace,
                    'schema': location}
        if kind and not schema_matches_kind(self.entries[location]['url'], kind):
            raise ValueError('Schema family does not match source representation')
        schema = self.compiled[location]
        valid = schema.validate(doc)
        return {'status': 'PASS' if valid else 'XSD_ERROR', 'schema': location,
                'root': local, 'namespace': namespace, 'schemaSha256': self.entries[location]['sha256'],
                'errors': [] if valid else [dict(line=e.line, column=e.column, code=e.type_name) for e in list(schema.error_log)[:8]]}



def validate_required(schemas, raw, source_url, kind, identifier=None, source_sha256=None):
    result = schemas.validate(raw, source_url, kind, identifier)
    result.update(profile=PROFILE, sourceSha256=source_sha256 or hashlib.sha256(raw).hexdigest(),
                  sourceBytes=len(raw), kind=kind, schemaBundleSha256=schemas.bundle_sha256)
    if result['status'] == 'NO_PINNED_SCHEMA':
        # No guessing a schema version from another document. Auxiliary RDF and
        # branch checks remain XML-only. A manifest with no declaration is explicit.
        optional = kind in ('CELLAR-RDF-tree', 'CELLAR-RDF-object', 'CELLAR-XML-branch')
        optional = optional or kind == 'BWB-manifest' and result['schema'] is None
        if not optional:
            result['status'] = 'SCHEMA_REQUIRED'
    if kind in ('CELLAR-RDF-tree', 'CELLAR-RDF-object') and result['status'] in ('PASS', 'NO_PINNED_SCHEMA'):
        result['rdfGraph'] = validate_rdf_graph(raw, source_url, identifier)
    return result


def check_runtime():
    if (sys.implementation.name != 'cpython' or sys.version_info[:2] != (3, 12)
            or etree.LXML_VERSION[:3] != (6, 1, 3) or rdflib.__version__ != '7.6.0'
            or pyparsing.__version__ != '3.3.3'):
        raise ValueError('Pinned XML/RDF runtime unavailable')


def serve(directory):
    check_runtime()
    schemas = PinnedSchemas(directory)
    print(json.dumps(dict(type='ready', profile=PROFILE, lxml='6.1.3', rdf='7.6.0', schemas=31)), flush=True)
    while True:
        header = sys.stdin.buffer.readline(16_385)
        if not header:
            return
        if len(header) > 16_384 or not header.endswith(b'\n'):
            raise ValueError('Invalid XML validation request header')
        request = json.loads(header)
        size, request_id = request.get('size'), request.get('id')
        if type(size) is not int or not 0 < size <= MAX_XML_BYTES or type(request_id) is not int:
            raise ValueError('Invalid XML validation request')
        raw = sys.stdin.buffer.read(size)
        actual_sha256 = hashlib.sha256(raw).hexdigest()
        if len(raw) != size or actual_sha256 != request.get('sha256'):
            raise ValueError('Truncated or modified XML validation payload')
        try:
            result = validate_required(schemas, raw, request['url'], request['kind'], request.get('identifier'), actual_sha256)
        except (ValueError, etree.LxmlError) as error:
            # Codes and locations suffice for diagnostics; never echo source text
            # or provider URLs containing arbitrary error/request information.
            result = dict(status='RDF_REJECTED' if isinstance(error, RejectedRdf) else 'XML_REJECTED', profile=PROFILE,
                          sourceSha256=request['sha256'], sourceBytes=size, kind=request['kind'],
                          error=type(error).__name__)
        print(json.dumps(dict(id=request_id, result=result)), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--schemas', type=Path, default=Path(__file__).resolve().parents[1] / 'docs/schema-research')
    args = parser.parse_args()
    if not args.serve:
        parser.error('--serve is required')
    try:
        serve(args.schemas)
    except Exception:
        print(json.dumps(dict(type='fatal', code='XML_VALIDATOR_UNAVAILABLE')), flush=True)
        raise SystemExit(1)
