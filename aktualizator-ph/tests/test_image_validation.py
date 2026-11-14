import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from PIL import Image

spec = importlib.util.spec_from_file_location('validate_image', Path(__file__).resolve().parents[1] / 'scripts/validate_image.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NativeImages(unittest.TestCase):
    def test_native_formats_are_verified_without_changing_any_byte(self):
        with tempfile.TemporaryDirectory() as directory:
            for kind, suffix in [('PNG', 'png'), ('JPEG', 'jpg'), ('WEBP', 'webp'), ('GIF', 'gif')]:
                buffer = io.BytesIO()
                Image.new('RGB', (3, 2), 'red').save(buffer, format=kind)
                original = buffer.getvalue()
                path = Path(directory) / 'source.bin'
                path.write_bytes(original)
                result = module.inspect_image(path)
                self.assertEqual(result['extension'], suffix)
                self.assertEqual(path.read_bytes(), original)
                path.write_bytes(original[:12])
                with self.assertRaises(Exception):
                    module.inspect_image(path)

    def test_svg_is_native_xml_and_active_or_entity_documents_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'image'
            path.write_bytes(b'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>')
            self.assertEqual(module.inspect_image(path)['extension'], 'svg')
            for bad in [b'<svg><script>alert(1)</script></svg>', b'<svg onload="run()"/>', b'<!DOCTYPE svg><svg/>', b'<html/>']:
                path.write_bytes(bad)
                with self.assertRaises(Exception):
                    module.inspect_image(path)
