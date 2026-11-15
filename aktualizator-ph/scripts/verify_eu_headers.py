"""Independent source replay for EU titles and labelled documentary dates."""
from datetime import date
import hashlib
import json
import re
from lxml import html

TITLE_CLASSES={'doc-ti','oj-doc-ti','title-doc','title-doc-first','title-doc-last','coj-sum-title-1'}
FIELDS=['work_date_document','official-journal-act_date_publication','resource_legal_date_publication']
CDM='http://publications.europa.eu/ontology/cdm#'


def normalized(text):
    return re.sub(r'[\s\ufeff]+',' ',text).strip()


def source_title(raw,url,identifier):
    raw.decode('utf-8-sig')  # Reject invalid UTF-8 independently of the HTML parser.
    tree=html.document_fromstring(raw,parser=html.HTMLParser(encoding='utf-8'))
    for el in tree.xpath('//script|//style|//noscript'):
        # drop_tree retains surrounding tail text, like removing a DOM node.
        el.drop_tree()
    fragments=[]
    blocks=tree.xpath('//body//*[self::p or self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6]')
    for ordinal,el in enumerate(blocks):
        text=normalized(el.text_content())
        if not text:continue
        classes=(el.get('class') or '').split()
        boundary=re.match(r'^(?:ANNEX(?:E)?|APPENDIX|BIJLAGE|BĲLAGE|AANHANGSEL|ZAŁĄCZNIK|DODATEK)(?:\s|$)',text,re.I) or any(c in {'oj-ti-art','ti-art','title-article','title-annex','oj-ti-annex'} for c in classes) or re.fullmatch(r'(?:Article|Artikel|Artykuł|Art\.)\s+(?:\d+[a-z]*|premier|unique|pierwszy|jedyny)',text,re.I)
        if boundary or re.fullmatch(r'Table of contents|Contents|Spis treści|Inhoudsopgave|Inhoud|Table des matières|Sommaire',text,re.I):break
        if TITLE_CLASSES.intersection(classes):fragments.append(dict(ordinal=ordinal,tag=el.tag,classes=classes,text=text))
        elif fragments:break
    provenance=dict(sourceUrl=url,sourceSha256=hashlib.sha256(raw).hexdigest(),fragments=fragments)
    if fragments:return dict(value=' '.join(f['text'] for f in fragments),provenance=dict(provenance,kind='xhtml-title-block'))
    identifiers=[el for el in tree.xpath('//body//h1') if normalized(el.text_content())==identifier]
    if len(identifiers)==1:
        paragraph=identifiers[0].getnext()
        if paragraph is not None and paragraph.tag=='p' and paragraph in blocks:
            legacy=[dict(ordinal=blocks.index(paragraph),tag='strong',classes=(el.get('class') or '').split(),text=normalized(el.text_content())) for el in paragraph.xpath('.//strong') if normalized(el.text_content())]
            if legacy:return dict(value=' '.join(f['text'] for f in legacy),provenance=dict(provenance,fragments=legacy,kind='legacy-xhtml-title'))
    titles=tree.xpath('//head/title');title=normalized(titles[0].text_content()) if titles else ''
    technical=not title or re.match(r'^EUR-Lex\b',title,re.I) or re.fullmatch(r'[0-9][A-Z0-9_()./-]+',title,re.I) or re.fullmatch(r'[\w.-]+\.(?:xml|xhtml|html)',title,re.I)
    return dict(value='CELEX '+identifier if technical else title,provenance=dict(provenance,kind='celex' if technical else 'html-title'))


def metadata(identifier,responses):
    values={}
    for kind,raw in responses:
        rows=json.loads(raw)['results']['bindings']
        for row in rows:
            if row.get('id',{}).get('value')!=identifier:continue
            if kind=='CELLAR-case-catalog':key,value='work_date_document',row.get('date',{}).get('value')
            else:
                prop=row.get('p',{}).get('value','')
                if not prop.startswith(CDM):continue
                key,value=prop[len(CDM):],row.get('v',{}).get('value')
            if key in FIELDS and value is not None:values.setdefault(key,set()).add(value)
    return {k:sorted(v) for k,v in values.items()}


def documentary_date(fields):
    values=set(v for values in fields.values() for v in values)
    valid=True
    for value in values:
        try:
            assert re.fullmatch(r'\d{4}-\d{2}-\d{2}',value)
            date.fromisoformat(value)
        except (AssertionError,ValueError):valid=False
    status='unknown' if not values else 'invalid' if not valid else 'confirmed' if len(values)==1 else 'ambiguous'
    return dict(value=next(iter(values)) if status=='confirmed' else None,status=status,fields=fields)


def expected_header(raw,url,identifier,responses):
    values=metadata(identifier,responses)
    layer=re.fullmatch(r'0\d{4}[A-Z]\d{4}(?:\(\d{2}\))?-(\d{4})(\d{2})(\d{2})(?:R\(\d{2}\))?',identifier)
    dates=dict(document=documentary_date({'work_date_document':values.get('work_date_document',[])}),
               consolidation=documentary_date({'celex-consolidation':['-'.join(layer.groups())] if layer else []}),
               publication=documentary_date({k:values.get(k,[]) for k in FIELDS[1:]}))
    return dict(profile='eu-document-header-v1',documentId=identifier,title=source_title(raw,url,identifier),dates=dates)


def verify_header(directory,document,raw,url,responses,files):
    expected=expected_header(raw,url,document['celex'],responses)
    assert document.get('header')==expected, 'EU title/date metadata differs from official original'
    title=re.sub(r'([\\\[\]<>])',r'\\\1',expected['title']['value'])
    def shown(field):
        value=expected['dates'][field]
        return value['value'] or 'niepotwierdzona ('+value['status']+')'
    lines=['Data dokumentu (work_date_document): '+shown('document'),
           'Data konsolidacji (CELEX): '+shown('consolidation'),
           'Data publikacji (metadane publikacji): '+shown('publication')]
    for record in files:
        text=(directory/record['name']).read_bytes().decode('utf-8')
        prefix=text.split('<!-- legal-structure-v1 body -->\n')[0]
        assert prefix.startswith('# '+title+'\n\n'), 'EU generated title differs from official original'
        assert all(prefix.splitlines().count(line)==1 for line in lines), 'EU generated date differs from official original'
