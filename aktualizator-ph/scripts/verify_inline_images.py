"""Independent validation of reversible Base64 presentation, without Node."""
import base64
from bisect import bisect_left
import hashlib
from html.parser import HTMLParser
import re
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlsplit, unquote

START = '<!-- legal-structure-v1 body -->\n'
END = '\n<!-- /legal-structure-v1 body -->'
class _CssUrlMatch:
    def __init__(self, whole, source, kind, position):
        self.whole, self.source, self.kind, self.position = whole, source, kind, position

    def start(self):
        return self.position

    def groups(self):
        return (self.source if self.kind == '"' else None,
                self.source if self.kind == "'" else None,
                self.source if self.kind == 'bare' else None)

    def __getitem__(self, index):
        return self.whole if index == 0 else self.groups()[index - 1]


class _CssUrlScanner:
    """Linear-time equivalent of the legacy CSS url(...) substitution regex."""
    @staticmethod
    def sub(replace, text):
        from array import array
        n = len(text)
        nonwhite = array('I', [n]) * (n + 1)
        double = array('I', [n]) * (n + 1)
        single = array('I', [n]) * (n + 1)
        stop = array('I', [n]) * (n + 1)
        for i in range(n - 1, -1, -1):
            char = text[i]
            nonwhite[i] = nonwhite[i + 1] if char.isspace() else i
            double[i] = i if char == '"' else double[i + 1]
            single[i] = i if char == "'" else single[i + 1]
            stop[i] = i if char.isspace() or char == ')' else stop[i + 1]
        opener = re.compile(r'url\\(', re.I)
        chunks = []
        position = 0
        last = 0
        while position < n:
            match = opener.search(text, position)
            if match is None:
                break
            start = match.start()
            begin = nonwhite[start + 4]
            end = -1
            kind = 'bare'
            source = ''
            if begin < n and text[begin] in ('"', "'"):
                quote = text[begin]
                last_quote = double[begin + 1] if quote == '"' else single[begin + 1]
                after = nonwhite[last_quote + 1 if last_quote < n else n]
                if last_quote < n and after < n and text[after] == ')':
                    end, kind = after, quote
                    source = text[begin + 1:last_quote]
            if end < 0:
                first_stop = stop[begin]
                after = nonwhite[first_stop]
                if after < n and text[after] == ')':
                    end = after
                    source = text[begin:first_stop]
            if end < 0:
                position = start + 4
                continue
            chunks.extend((text[last:start],
                           replace(_CssUrlMatch(text[start:end + 1], source, kind, start))))
            position = last = end + 1
        return ''.join(chunks) + text[last:]


URL = _CssUrlScanner()


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def units(value):
    return len(value.encode('utf-16-le')) // 2


def cut(value, start, end):
    assert type(start) is int and type(end) is int and 0 <= start <= end <= units(value)
    return value.encode('utf-16-le')[2*start:2*end].decode('utf-16-le')


def restore(name, rendered, index):
    rendering = index.get('rendering')
    if not rendering:
        return rendered
    assert rendering['profile'] == 'inline-base64-v1'
    assert rendering['offsetEncoding'] == 'utf16-code-units'
    assert rendering['patchScope'] == 'full-markdown'
    assert rendering['legalOffsetScope'] == 'restored-canonical-body'
    records = [f for f in rendering['files'] if f['name'] == name]
    if not records:
        return rendered
    assert len(records) == 1
    record = records[0]
    assert sha(rendered) == record['renderedSha256']
    pieces, previous, canonical_end, delta = [], 0, 0, 0
    for patch in record['patches']:
        a, b = patch['renderedStart'], patch['renderedEnd']
        assert patch['canonicalStart'] >= canonical_end
        assert a == patch['canonicalStart'] + delta and a >= previous
        assert units(patch['original']) == patch['canonicalEnd'] - patch['canonicalStart']
        assert sha(cut(rendered, a, b)) == patch['renderedSha256']
        pieces.extend([cut(rendered, previous, a), patch['original']])
        previous, canonical_end = b, patch['canonicalEnd']
        delta += b-a-units(patch['original'])
    pieces.append(cut(rendered, previous, units(rendered)))
    canonical = ''.join(pieces)
    assert sha(canonical) == record['canonicalSha256']
    return canonical


def mapped(position, patches, end=False):
    delta = 0
    for p in patches:
        if position < p['canonicalStart']:
            break
        if position < p['canonicalEnd']:
            return p['renderedEnd'] if end else p['renderedStart']
        delta += p['renderedEnd']-p['renderedStart']-(p['canonicalEnd']-p['canonicalStart'])
    return position+delta


class Graphics(HTMLParser):
    def __init__(self, markdown):
        super().__init__(convert_charrefs=True)
        assert markdown.count(START) == markdown.count(END) == 1
        self.prefix, rest = markdown.split(START)
        self.body = rest.split(END)[0]
        self.astral = [i for i,c in enumerate(self.body) if ord(c) > 0xffff]
        self.base = units(self.prefix+START)
        self.lines = [0]
        self.lines.extend(m.end() for m in re.finditer('\n', self.body))
        self.nodes, self.svg, self.styles = [], [], []
        self.feed(self.body)

    def position(self):
        line, column = self.getpos()
        return self.lines[line-1]+column

    def u16_position(self, position):
        return self.base+position+bisect_left(self.astral,position)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag not in {'img','image','feimage','use','svg','style'} and 'style' not in attrs:
            return
        start = self.position()
        node = dict(tag=tag, attrs=attrs, start=self.u16_position(start),
                    end=self.u16_position(start+len(self.get_starttag_text())))
        if tag in {'img', 'image', 'feimage', 'use', 'svg'} or 'style' in node['attrs'] or tag == 'style':
            self.nodes.append(node)
        if tag == 'svg': self.svg.append(node)
        if tag == 'style': self.styles.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag == 'svg': self.svg.pop()
        if tag == 'style': self.styles.pop()

    def handle_endtag(self, tag):
        if tag == 'svg' and self.svg:
            node = self.svg.pop()
            node['end'] = self.u16_position(self.position()+len('</svg>'))
        if tag == 'style' and self.styles:
            node = self.styles.pop()
            node['end'] = self.u16_position(self.position()+len('</style>'))


def decoded(uri):
    match = re.fullmatch(r'data:(image/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})(?:#[^\s]*)?', uri, re.I)
    assert match, 'Final graphic is not Base64'
    data = base64.b64decode(match[2], validate=True)
    assert data and base64.b64encode(data).decode() == match[2]
    return match[1].lower(), data


def verify_svg_derivation(proof, derived, depth=0):
    """Compare original vector geometry/text with its self-contained derivative."""
    assert depth <= 8 and proof['profile'] == 'self-contained-svg-v1'
    original = base64.b64decode(proof['originalBase64'], validate=True)
    assert sha(original) == proof['originalSha256']
    assert b'<!DOCTYPE' not in original.upper() and b'<!ENTITY' not in original.upper()
    assert b'<!DOCTYPE' not in derived.upper() and b'<!ENTITY' not in derived.upper()
    resources, used = proof['resources'], set()
    assert len({r['index'] for r in resources}) == len(resources)
    for resource in resources:
        raw = base64.b64decode(resource['base64'], validate=True)
        assert sha(raw) == resource['sha256']
        assert resource['requestUrl'] == (resource['source'] if resource['source'].startswith('data:') else urljoin(proof['responseUrl'], resource['source']))
        if resource.get('derivation'):
            assert resource['derivation']['requestUrl'] == resource['requestUrl']
            assert resource['derivation']['responseUrl'] == resource['responseUrl']
            verify_svg_derivation(resource['derivation'], raw, depth+1)
        # Use a native decoder independently of the TypeScript receipt.
        import tempfile
        from pathlib import Path
        from validate_image import inspect_image
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'graphic';path.write_bytes(raw)
            assert inspect_image(path)['contentType'] == resource['contentType']

    def token(uri, output):
        if uri.startswith('#'): return uri
        fragment = '#'+unquote(urlsplit(uri).fragment) if urlsplit(uri).fragment else ''
        if output: return sha(decoded(uri)[1])+fragment
        found = [r for r in resources if r['source'] == uri]
        assert found and len({r['sha256'] for r in found}) == 1
        used.update(r['index'] for r in found)
        return found[0]['sha256']+fragment

    def css(value, output):
        def replace(match):
            uri = next(v for v in match.groups() if v is not None)
            prefix=value[:match.start()];a,b=prefix.rfind('{'),prefix.rfind('}')
            scope=prefix[b+1:a] if a>b else prefix[prefix.rfind(';')+1:]
            if uri.startswith('#') or re.search(r'@font-face\b|^\s*@import\b',scope,re.I):return match[0]
            return 'url(GRAPHIC:'+token(uri,output)+')'
        return URL.sub(replace,value)

    def normalized(raw, output):
        def walk(e):
            local=e.tag.rsplit('}',1)[-1];attrs=[]
            for key,value in e.attrib.items():
                if local in {'image','feImage','use'} and key.rsplit('}',1)[-1] in {'href','src'}:value=token(value,output)
                elif key=='style':value=css(value,output)
                attrs.append((key,value))
            text=css(e.text or '',output) if local=='style' else e.text
            return e.tag,sorted(attrs),text,e.tail,[walk(c) for c in e]
        return walk(ET.fromstring(raw))
    assert normalized(original,False)==normalized(derived,True), 'SVG derivative changed original geometry or text'
    assert used == {r['index'] for r in resources}, 'Unreferenced SVG dependency proof'


def audit_inline(directory, index, documents):
    for source in index.get('sources', []):
        if source.get('derivation'):
            assets=[a for a in index['assets'] if a['sha256']==source['sha256']]
            assert len(assets)==1
            assert source['derivation']['responseUrl']==source['responseUrl']
            assert source['derivation']['requestUrl']==(source.get('resolution',{}).get('attempts') or [{'url':source['requestUrl']}])[-1]['url']
            verify_svg_derivation(source['derivation'],(directory/assets[0]['name']).read_bytes())
    if not index.get('rendering'):
        return {}
    names = {p['file'] for doc in documents for p in doc['parts']}
    records = index['rendering']['files']
    assert len(records) == len(names) and {f['name'] for f in records} == names
    assets = {a['name']: a for a in index['assets']}
    source_targets = {(s.get('baseUrl'),s['requestUrl']): s['sha256'] for s in index['sources']}
    canonical_files = {}
    for record in records:
        name = record['name']
        rendered = (directory/name).read_bytes().decode('utf-8')
        canonical = restore(name, rendered, index)
        canonical_files[name] = canonical
        original, final = Graphics(canonical), Graphics(rendered)
        occurrences = [o for o in index['occurrences'] if o['markdownFile'] == name]
        omissions = [o for o in index.get('omittedDecorations', []) if o['markdownFile'] == name]
        gaps = [o for o in index.get('unavailableImages', []) if o['markdownFile'] == name]
        gap_urls = {o['imageUrl'] for o in gaps}
        for gap in gaps:
            attempts = gap['attempts']
            assert attempts and all(a['outcome'] == 'UNAVAILABLE' and a['reason'] for a in attempts)
            assert len({a['language'] for a in attempts}) == len(attempts)
            if gap['language'] in {'EN', 'PL', 'FR'} or gap['documentId'][:1] in {'0','3','6'}:
                assert {a['language'] for a in attempts} == {'EN','PL','NL','FR'}
        for omission in omissions:
            assert omission['reason'] == 'decorative-european-flag'
            assert omission['imageUrl'].split('?',1)[0].endswith('/europeanflag.gif')

        def token(uri, base, output=False):
            if uri.startswith('#'): return uri
            absolute = urljoin(base, uri)
            if not output and absolute in gap_urls: return None
            fragment='#'+unquote(urlsplit(uri).fragment) if urlsplit(uri).fragment else ''
            if not output and (base,absolute) in source_targets:return source_targets[(base,absolute)]+fragment
            if not output and (None,absolute) in source_targets:return source_targets[(None,absolute)]+fragment
            if uri.startswith('data:'):
                return sha(decoded(uri)[1])+fragment
            assert not output, 'Final graphics still depend on a URL'
            raise AssertionError('Graphic source lacks native evidence')

        def css(value, base, output=False):
            def replace(match):
                prefix = value[:match.start()]
                open_brace, close_brace = prefix.rfind('{'), prefix.rfind('}')
                scope = prefix[close_brace+1:open_brace] if open_brace > close_brace else prefix[prefix.rfind(';')+1:]
                uri = next(v for v in match.groups() if v is not None)
                if uri.startswith('#') or re.search(r'@font-face\b|^\s*@import\b', scope, re.I): return match[0]
                identity = token(uri, base, output)
                return 'none' if identity is None else 'url(GRAPHIC:'+identity+')'
            return URL.sub(replace, value)

        outer = [n for n in original.nodes if n['tag']=='svg' and not any(p is not n and p['tag']=='svg' and p['start']<=n['start'] and p['end']>=n['end'] for p in original.nodes)]
        spans = []
        used_final = set()
        for n in original.nodes:
            if n['tag'] in {'img','image','feimage','use','svg'} or any(o['kind']=='css' and o['offset']==n['start']-original.base for o in occurrences+gaps):
                spans.append((n['start'], n['end']))
        for p in record['patches']:
            assert any(a <= p['canonicalStart'] <= p['canonicalEnd'] <= b for a,b in spans), 'Rendering modified legal text outside graphics'
        for n in original.nodes:
            if any(p is not n and p['start']<=n['start'] and p['end']>=n['end'] for p in outer): continue
            matching = [o for o in occurrences+omissions+gaps if o['offset'] == n['start']-original.base]
            if not matching: continue
            primary = {'img':'img','image':'svg-image','feimage':'svg-image','use':'svg-image','svg':'inline-svg'}.get(n['tag'],'css')
            matching = sorted(matching,key=lambda o:o['kind']!=primary)
            p = matching[0]
            start = mapped(n['start'], record['patches'])
            end = mapped(n['end'], record['patches'], True)
            fragment = cut(rendered, start, end)
            if p in omissions:
                assert n['tag']=='img' and n['attrs'].get('alt')=='European flag'
                assert 'omitted decorative OJ flag' in fragment
                continue
            if p in gaps and n['tag'] in {'img','image','feimage','use','svg'}:
                assert 'Grafika' in fragment and 'niedostępna' in fragment and '<img' not in fragment
                continue
            targets = {o['target'] for o in occurrences if o['offset']==p['offset'] and o['kind']==p['kind']}
            if n['tag'] in {'img','image','feimage','use','svg'}:
                found = [x for x in final.nodes if x['start']==start]
                assert len(found)==1
                output = found[0]
                used_final.add(output['start'])
                attr = 'src' if output['tag']=='img' else 'href' if 'href' in output['attrs'] else 'xlink:href'
                mime, data = decoded(output['attrs'][attr])
                assert len(targets)==1
                native = assets[next(iter(targets))]
                if n['tag']!='svg':
                    original_attr = 'src' if n['tag']=='img' else 'href' if 'href' in n['attrs'] else 'xlink:href'
                    assert output['tag']==n['tag']
                    assert {k:v for k,v in n['attrs'].items() if k not in {original_attr,'style'}} == {k:v for k,v in output['attrs'].items() if k not in {attr,'style'}}
                    assert sha(data)==native['sha256'] and mime==native['contentType']
                    assert unquote(urlsplit(output['attrs'][attr]).fragment)==unquote(urlsplit(n['attrs'][original_attr]).fragment), 'Graphic view/fragment changed'
                else:
                    assert mime=='image/svg+xml' and b'<!DOCTYPE' not in data.upper() and b'<!ENTITY' not in data.upper()
                    raw = (directory/native['name']).read_bytes()
                    def normalized(raw, output=False):
                        root = ET.fromstring(raw)
                        def walk(e):
                            local=e.tag.rsplit('}',1)[-1]
                            if output and local=='text' and e.text=='Grafika niedostępna':return ('MISSING_IMAGE', [], None, e.tail, [])
                            attrs=[]
                            for key,value in e.attrib.items():
                                if local in {'image','feImage','use'} and key.rsplit('}',1)[-1] in {'href','src'}:
                                    value=token(value,p['sourceUrl'],output)
                                    if value is None:return ('MISSING_IMAGE', [], None, e.tail, [])
                                elif key=='style':value=css(value,p['sourceUrl'],output)
                                attrs.append((key,value))
                            text=css(e.text or '',p['sourceUrl'],output) if local=='style' else e.text
                            return e.tag,sorted(attrs),text,e.tail,[walk(c) for c in e]
                        return walk(root)
                    assert normalized(raw)==normalized(data,True), 'SVG geometry or dependencies changed'
            if n['tag']!='svg' and 'style' in n['attrs']:
                found=[x for x in final.nodes if x['start']==start]
                assert len(found)==1
                a,b=dict(n['attrs']),dict(found[0]['attrs'])
                if n['tag'] in {'img','image','feimage','use'}:
                    a.pop(original_attr,None);b.pop(attr,None)
                assert css(a.pop('style'),p['sourceUrl'])==css(b.pop('style'),p['sourceUrl'],True) and a==b
            elif n['tag']=='style':
                old=cut(canonical,n['start'],n['end']);new=fragment
                assert css(old,p['sourceUrl'])==css(new,p['sourceUrl'],True)
        for n in final.nodes:
            assert n['tag']!='svg', 'Unencoded final SVG'
            if n['tag'] in {'img','image','feimage','use'}:
                assert n['start'] in used_final, 'Unexpected final graphic'
                decoded(n['attrs'].get('src') or n['attrs'].get('href') or n['attrs'].get('xlink:href',''))
    return canonical_files
