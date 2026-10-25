"""Offline package check; never downloads or changes model files."""
import hashlib
import json
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
import torch, PIL, numpy, scipy, gguf
print('Python:', sys.version.split()[0], 'PyTorch:', torch.__version__)
manifest = json.loads((root / 'models/manifest.json').read_text(encoding='utf-8'))
errors = []
for item in manifest:
    p = root / 'models' / item['path']
    if not p.exists() or p.stat().st_size != item['size']:
        errors.append(item['path'] + ': missing/incomplete')
    else:
        print('Checking:', item['path'], flush=True)
        if '--quick' in sys.argv:
            continue
        with p.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != item['sha256']:
            errors.append(item['path'] + ': checksum mismatch')
if errors:
    print('\n'.join(errors))
    sys.exit(1)
print('PASS: runtime imports and model sizes are correct.' if '--quick' in sys.argv else 'PASS: runtime imports and all three model checksums are correct.')
