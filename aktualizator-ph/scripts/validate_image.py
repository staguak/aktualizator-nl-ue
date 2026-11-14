"""Decode/verify native image bytes; never rewrite or re-encode them."""
import hashlib
import json
from pathlib import Path
import sys
import warnings
import xml.etree.ElementTree as ET


def inspect_image(path):
    data = Path(path).read_bytes()
    if not data:
        raise ValueError('EMPTY_IMAGE')
    if data.lstrip().startswith((b'<', b'\xef\xbb\xbf<')):
        if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
            raise ValueError('IMAGE_ENTITY_FORBIDDEN')
        root = ET.fromstring(data)
        if root.tag != '{http://www.w3.org/2000/svg}svg':
            raise ValueError('NOT_SVG')
        for element in root.iter():
            if element.tag.rsplit('}', 1)[-1].lower() in {'script', 'foreignobject'}:
                raise ValueError('ACTIVE_SVG_FORBIDDEN')
            if any(name.rsplit('}', 1)[-1].lower().startswith('on') for name in element.attrib):
                raise ValueError('ACTIVE_SVG_FORBIDDEN')
            for name, value in element.attrib.items():
                if name.rsplit('}', 1)[-1] in {'href', 'src'} and ':' in value and not value.startswith(('https:', 'http:', 'data:image/')):
                    raise ValueError('ACTIVE_SVG_FORBIDDEN')
        native = dict(format='SVG', contentType='image/svg+xml', extension='svg')
    else:
        from PIL import Image
        formats = {'PNG': ('image/png', 'png'), 'JPEG': ('image/jpeg', 'jpg'),
                   'WEBP': ('image/webp', 'webp'), 'GIF': ('image/gif', 'gif'),
                   'TIFF': ('image/tiff', 'tif'), 'BMP': ('image/bmp', 'bmp'),
                   'ICO': ('image/x-icon', 'ico'), 'AVIF': ('image/avif', 'avif')}
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(path) as image:
                kind = image.format
                if kind not in formats:
                    raise ValueError('UNSUPPORTED_NATIVE_IMAGE')
                image.verify()
            with Image.open(path) as image:
                # Decode each original frame; verification alone can miss a
                # truncated pixel stream or a corrupt later GIF/TIFF frame.
                for frame in range(getattr(image, 'n_frames', 1)):
                    image.seek(frame)
                    image.load()
                native = dict(format=kind, contentType=formats[kind][0],
                              extension=formats[kind][1], width=image.width, height=image.height)
    return dict(native, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('ARGUMENT_INVALID')
        print(json.dumps(inspect_image(sys.argv[1]), sort_keys=True))
    except Exception:
        print(json.dumps({'error': 'IMAGE_VALIDATION_FAILED'}))
        sys.exit(1)
