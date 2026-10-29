"""Prepare the bundled preview GLB, preserving the original modeling files.

The source GLB omitted baseColorFactor for procedural materials. Restore only
their constant base colours from build_from_reference.py; no texture baking.
"""
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / '武夷茶故事_剧本与3D建模文件' / '02_3D建模' / '02_先出图再建模_20261024' / '03_网页预览模型.glb'
raw = SOURCE.read_bytes()
json_size = struct.unpack_from('<I', raw, 12)[0]
document = json.loads(raw[20:20 + json_size])
colours = {
    'Warm lime plaster': [.67, .61, .49], 'Dark aged timber': [.115, .057, .027],
    'Timber edges': [.18, .091, .039], 'Blue grey stone': [.37, .38, .34],
    'Ground and grout': [.20, .20, .175],
}
colours.update({f'Flagstone variation {i}': [.32 + i*.019, .33 + i*.018, .30 + i*.016] for i in range(6)})
colours.update({f'Charcoal clay {i}': [.078 + i*.009, .085 + i*.009, .080 + i*.009] for i in range(5)})
restored = 0
for material in document.get('materials', []):
    pbr = material.setdefault('pbrMetallicRoughness', {})
    if material['name'] in colours and 'baseColorFactor' not in pbr:
        pbr['baseColorFactor'] = colours[material['name']] + [1]
        restored += 1
document.setdefault('asset', {}).setdefault('extras', {})['previewMaterialNote'] = 'Constant base colors restored from original build_from_reference.py. Procedural textures are not baked.'
payload = json.dumps(document, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
payload += b' ' * ((-len(payload)) % 4)
tail = raw[20 + json_size:]
result = struct.pack('<III', 0x46546C67, 2, 20 + len(payload) + len(tail)) + struct.pack('<II', len(payload), 0x4E4F534A) + payload + tail
(ROOT / 'assets' / 'temple-gate.glb').write_bytes(result)
print(f'Restored {restored} material base colours in bundled preview GLB; original unchanged.')
