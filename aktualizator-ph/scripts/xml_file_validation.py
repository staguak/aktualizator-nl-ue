"""Streaming original-file validation and an ephemeral, disk-backed RDF graph.

The caller supplies an already opened, verified file. No URL is dereferenced.
Byte/character limits belong to the runner's resources, not this file API.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
from urllib.parse import unquote, urljoin, urlsplit

from lxml import etree
import rdflib
from rdflib import BNode, Graph, Literal, URIRef
from rdflib.store import Store
from rdflib.exceptions import ParserError
from rdflib.parser import InputSource
from xml.sax import SAXParseException


def transport_identity(value):
    parsed = urlsplit(str(value))
    if parsed.hostname == 'publications.europa.eu' and parsed.path.startswith('/resource/'):
        return 'https://publications.europa.eu' + unquote(parsed.path).split('/rdf/')[0]
    return str(value).split('/rdf/')[0]


def encode_term(term):
    if isinstance(term, Literal):
        return json.dumps(['l', str(term), term.language, str(term.datatype) if term.datatype else None],
                          ensure_ascii=False, separators=(',', ':'))
    if isinstance(term, URIRef):
        return json.dumps(['u', str(term)], ensure_ascii=False, separators=(',', ':'))
    if isinstance(term, BNode):
        return json.dumps(['b', str(term)], ensure_ascii=False, separators=(',', ':'))
    raise ValueError('Unsupported RDF term')


def decode_term(value):
    parts = json.loads(value)
    if parts[0] == 'u':
        return URIRef(parts[1])
    if parts[0] == 'b':
        return BNode(parts[1])
    if parts[0] == 'l':
        return Literal(parts[1], lang=parts[2], datatype=parts[3], normalize=False)
    raise ValueError('Invalid stored RDF term')


class SqliteRdfStore(Store):
    """Single-graph RDFLib Store; triples stay on disk, including deduplication."""
    context_aware = False
    formula_aware = False
    transaction_aware = False

    def __init__(self, filename, reject):
        super().__init__()
        self.reject = reject
        self.db = sqlite3.connect(str(filename))
        self.db.execute('PRAGMA journal_mode=OFF')
        self.db.execute('PRAGMA synchronous=OFF')
        self.db.execute('PRAGMA temp_store=FILE')
        self.db.execute('PRAGMA cache_size=-8192')
        self.db.execute('CREATE TABLE triples (s TEXT NOT NULL,p TEXT NOT NULL,o TEXT NOT NULL,PRIMARY KEY(s,p,o)) WITHOUT ROWID')
        self.db.execute('CREATE INDEX triples_po ON triples(p,o)')
        self.db.execute('CREATE TABLE aliases (a TEXT NOT NULL,b TEXT NOT NULL,PRIMARY KEY(a,b)) WITHOUT ROWID')
        self.db.execute('CREATE TABLE subjects (term TEXT PRIMARY KEY,identity TEXT NOT NULL) WITHOUT ROWID')
        self.db.execute('CREATE INDEX subject_identity ON subjects(identity)')
        self.bindings = {}
        self.count = 0
        self.context = None

    def add(self, triple, context, quoted=False):
        if quoted:
            raise self.reject('Quoted RDF graph is not an RDF/XML source')
        subject, predicate, value = triple
        if isinstance(value, Literal) and getattr(value, 'ill_typed', False):
            raise self.reject('Ill-typed RDF literal')
        s, p, o = (encode_term(term) for term in triple)
        inserted = self.db.execute('INSERT OR IGNORE INTO triples VALUES (?,?,?)', (s, p, o)).rowcount
        if inserted:
            self.count += 1
            if isinstance(subject, URIRef):
                self.db.execute('INSERT OR IGNORE INTO subjects VALUES (?,?)', (s, transport_identity(subject)))
            if str(predicate) == 'http://www.w3.org/2002/07/owl#sameAs' and isinstance(subject, URIRef) and isinstance(value, URIRef):
                a, b = transport_identity(subject), transport_identity(value)
                self.db.executemany('INSERT OR IGNORE INTO aliases VALUES (?,?)', ((a, b), (b, a)))
        self.context = context

    def triples(self, triple_pattern, context=None):
        clauses, values = [], []
        for column, value in zip(('s', 'p', 'o'), triple_pattern):
            if value is not None:
                clauses.append(column + '=?')
                values.append(encode_term(value))
        query = 'SELECT s,p,o FROM triples' + (' WHERE ' + ' AND '.join(clauses) if clauses else '')
        for row in self.db.execute(query, values):
            yield tuple(decode_term(value) for value in row), iter((self.context,))

    def __len__(self, context=None):
        return self.count

    def bind(self, prefix, namespace, override=True):
        if override or prefix not in self.bindings:
            self.bindings[prefix] = namespace

    def namespace(self, prefix):
        return self.bindings.get(prefix)

    def prefix(self, namespace):
        return next((prefix for prefix, value in self.bindings.items() if value == namespace), None)

    def namespaces(self):
        return iter(self.bindings.items())

    def close(self, commit_pending_transaction=False):
        self.db.close()

    def aliases_for(self, value):
        return (row[0] for row in self.db.execute('SELECT b FROM aliases WHERE a=?', (value,)))

    def subject_aliases(self, reachable):
        for identity in sorted(reachable):
            for row in self.db.execute('SELECT term FROM subjects WHERE identity=?', (identity,)):
                yield decode_term(row[0])


def rdf_file_graph(source, source_url, identifier, reject, profile, max_facts):
    # XML syntax and the absence of DTD/entities are established first. RDFLib's
    # SAX RDF/XML parser emits terms into SQLite instead of a Memory store.
    rdflib.NORMALIZE_LITERALS = False
    with tempfile.TemporaryDirectory(prefix='updater-rdf-index-') as tmp:
        store = SqliteRdfStore(Path(tmp) / 'graph.sqlite', reject)
        try:
            graph = Graph(store=store)
            source.seek(0)
            class HeldStream:
                def read(self, size=-1):
                    return source.read(size)

                def close(self):
                    pass  # SAX must not close the descriptor held for hash checks.

            rdf_source = InputSource(source_url or 'urn:nl-eu-updater:rdf-source')
            rdf_source.setByteStream(HeldStream())
            try:
                graph.parse(source=rdf_source, format='xml', publicID=source_url or 'urn:nl-eu-updater:rdf-source')
            except (ParserError, SAXParseException) as error:
                raise reject('Invalid RDF/XML graph grammar') from error
            cdm = 'http://publications.europa.eu/ontology/cdm#'
            ids = URIRef(cdm + 'resource_legal_id_celex')
            works = set()
            if identifier:
                for subject, _, value in graph.triples((None, ids, None)):
                    if isinstance(value, Literal) and str(value) == identifier:
                        works.add(subject)
                        if len(works) > max_facts:
                            raise reject('RDF identity assertion resource limit exceeded')
                if not works:
                    raise reject('Requested CELEX absent from RDF graph')
            reachable = {transport_identity(source_url)}
            pending = list(reachable)
            while pending:
                for alias in store.aliases_for(pending.pop()):
                    if alias not in reachable:
                        reachable.add(alias)
                        pending.append(alias)
                if len(reachable) > 256:
                    raise reject('Ambiguous RDF resource identity closure')
            selected_works = {work for work in works if transport_identity(work) in reachable}
            if identifier and not selected_works:
                raise reject('Requested CELEX is unrelated to the returned RDF resource')
            # Direct facts often live on an OJ alias, while only the CELEX alias
            # has resource_legal_id_celex. Include only explicit work aliases.
            subjects = list(store.subject_aliases(reachable)) if identifier else []
            facts, opaque = [], 0
            for subject in subjects:
                for _, predicate, value in graph.triples((subject, None, None)):
                    if not str(predicate).startswith(cdm):
                        continue
                    local = str(predicate)[len(cdm):]
                    if not re.search('date|in.force|amend|modif|correct|repeal|annul|consolidat|id_celex', local):
                        continue
                    if isinstance(value, BNode):
                        opaque += 1
                        continue
                    if len(facts) >= max_facts:
                        raise reject('RDF assertion resource limit exceeded')
                    term = dict(type='literal' if isinstance(value, Literal) else 'uri', value=str(value))
                    if isinstance(value, Literal):
                        term.update(datatype=str(value.datatype) if value.datatype else None, language=value.language)
                    facts.append(dict(subject=str(subject), predicate=str(predicate), object=term,
                                      classification='OFFICIAL_VALUE', locator='RDF subject/predicate/object'))
            facts.sort(key=lambda item: json.dumps(item, sort_keys=True))
            values = {}
            for fact in facts:
                values.setdefault((fact['subject'], fact['predicate']), []).append(fact['object'])
            multiple = [dict(subject=s, predicate=p, values=v, status='MULTIPLE_VALUES_UNRESOLVED')
                        for (s, p), v in sorted(values.items()) if len(v) > 1]
            unrelated = sorted(str(work) for work in works - selected_works if isinstance(work, URIRef))
            return dict(profile=profile, status='PASS', triples=len(graph),
                        identity='CONFIRMED' if works else 'NOT_CHECKED', requestedCelex=identifier,
                        unrelatedCelexSubjects=unrelated,
                        opaqueUnrelatedCelexSubjects=sum(isinstance(work, BNode) for work in works - selected_works),
                        identityScope='Returned resource and explicit owl:sameAs aliases; no legal-effect inference',
                        facts=facts, multipleValues=multiple, opaqueAssertions=opaque,
                        storage='SQLITE_STREAMING_FILE',
                        scope='RDF grammar, typed literals and direct selected-work/explicit-alias CDM assertions; '
                              'no ontology closure, inferred legal effects or complete legal history')
        finally:
            store.close()


class RootInspector:
    def __init__(self, identity_check, kind, identifier):
        self.identity_check, self.kind, self.identifier = identity_check, kind, identifier
        self.root = None
        self.depth = 0

    def start(self, tag, attrs):
        self.depth += 1
        # A structural recursion/resource bound, not a source byte/character cap.
        if self.depth > 2048:
            raise ValueError('XML structural resource limit exceeded')
        if self.root is None:
            self.root = etree.Element(tag, attrs)
            self.identity_check(self.root, self.kind, self.identifier)

    def end(self, tag):
        self.depth -= 1

    def data(self, value):
        pass

    def doctype(self, name, public_id, system_id):
        raise ValueError('DTD is not permitted by the official XML validation profile')

    def close(self):
        if self.root is None or self.depth:
            raise ValueError('Incomplete XML source')
        return self.root


def consume_xml(source, parser, clear_tree=False):
    source.seek(0)
    digest, size = hashlib.sha256(), 0
    while True:
        chunk = source.read(256 * 1024)
        if not chunk:
            break
        size += len(chunk)
        digest.update(chunk)
        parser.feed(chunk)
        if clear_tree:
            for _, element in parser.read_events():
                element.clear(keep_tail=True)
                parent = element.getparent()
                if parent is not None:
                    while element.getprevious() is not None:
                        del parent[0]
    root = parser.close()
    if not size:
        raise ValueError('Empty XML source')
    return root, digest.hexdigest(), size


def validate_file_stream(schemas, source, source_url, kind, identifier, expected_sha,
                         identity_check, deny_external, schema_matches, reject_rdf,
                         profile, rdf_profile, max_facts):
    before = os.fstat(source.fileno())
    inspector = RootInspector(identity_check, kind, identifier)
    parser = etree.XMLParser(target=inspector, no_network=True, resolve_entities=False,
                             load_dtd=False, recover=False, huge_tree=True)
    parser.resolvers.add(deny_external())
    root, digest, size = consume_xml(source, parser)
    if digest != expected_sha:
        raise ValueError('Original source checksum mismatch')
    namespace, local = etree.QName(root).namespace, etree.QName(root).localname
    xsi = '{http://www.w3.org/2001/XMLSchema-instance}'
    if namespace:
        pairs = root.get(xsi + 'schemaLocation', '').split()
        if len(pairs) % 2:
            raise ValueError('Invalid namespace/schema location pairs')
        locations = [pairs[i + 1] for i in range(0, len(pairs), 2) if pairs[i] == namespace]
        if len(locations) > 1:
            raise ValueError('Ambiguous root namespace schema location')
        location = locations[0] if locations else None
    else:
        location = root.get(xsi + 'noNamespaceSchemaLocation')
    if location and not location.startswith(('https:', 'http:')):
        location = urljoin(source_url, location)
    result = dict(status='NO_PINNED_SCHEMA', root=local, namespace=namespace, schema=location)
    if location and location in schemas.compiled:
        if not schema_matches(schemas.entries[location]['url'], kind):
            raise ValueError('Schema family does not match source representation')
        # A target parser silently bypasses lxml's schema validation. Use an
        # event parser here and explicitly clear completed nodes, including
        # siblings; XSD identity constraints remain libxml2's responsibility.
        checked = etree.XMLPullParser(events=('end',), schema=schemas.compiled[location],
                                      no_network=True, resolve_entities=False,
                                      load_dtd=False, recover=False, huge_tree=True)
        checked.resolvers.add(deny_external())
        try:
            _, second_digest, second_size = consume_xml(source, checked, clear_tree=True)
        except etree.XMLSyntaxError as error:
            result.update(status='XSD_ERROR', schemaSha256=schemas.entries[location]['sha256'],
                          errors=[dict(line=e.line, column=e.column, code=e.type_name)
                                  for e in list(error.error_log)[-8:]])
        else:
            if (second_digest, second_size) != (digest, size):
                raise ValueError('Original source changed between validation passes')
            result.update(status='PASS', schemaSha256=schemas.entries[location]['sha256'], errors=[])
    if result['status'] == 'NO_PINNED_SCHEMA':
        optional = kind in ('CELLAR-RDF-tree', 'CELLAR-RDF-object', 'CELLAR-XML-branch')
        optional = optional or kind == 'BWB-manifest' and location is None
        if not optional:
            result['status'] = 'SCHEMA_REQUIRED'
    if kind in ('CELLAR-RDF-tree', 'CELLAR-RDF-object') and result['status'] in ('PASS', 'NO_PINNED_SCHEMA'):
        result['rdfGraph'] = rdf_file_graph(source, source_url, identifier, reject_rdf, rdf_profile, max_facts)
    # Re-read from the held descriptor after all passes; it also prevents a
    # same-size in-place modification from reusing a previous validation seal.
    final_digest = hashlib.sha256()
    source.seek(0)
    for chunk in iter(lambda: source.read(256 * 1024), b''):
        final_digest.update(chunk)
    after = os.fstat(source.fileno())
    fingerprint = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
    if final_digest.hexdigest() != digest or fingerprint(before) != fingerprint(after):
        raise ValueError('Original source changed during validation')
    result.update(profile=profile, sourceSha256=digest, sourceBytes=size, kind=kind,
                  schemaBundleSha256=schemas.bundle_sha256, validationMode='STREAMING_FILE')
    return result


def open_source_file(filename, roots):
    """Accept only regular files below trusted roots, with no symlink ancestor."""
    if not isinstance(filename, (str, os.PathLike)):
        raise ValueError('Invalid local source path')
    file = Path(filename)
    if not file.is_absolute() or not roots:
        raise ValueError('Invalid local source path')
    file = Path(os.path.abspath(file))
    permitted = False
    for root in roots:
        root = Path(os.path.abspath(root))
        try:
            file.relative_to(root)
        except ValueError:
            continue
        if file != root:
            permitted = True
            break
    if not permitted:
        raise ValueError('Local source path is outside the configured source directory')
    current = file
    while True:
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError('Symlinked XML source path is forbidden')
        if current == current.parent:
            break
        current = current.parent
    fd = os.open(file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or not info.st_size:
            raise ValueError('Local XML source must be a nonempty regular file')
        return os.fdopen(fd, 'rb')
    except BaseException:
        os.close(fd)
        raise
