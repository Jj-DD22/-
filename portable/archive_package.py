"""Archive only distributable files, then verify ZIP CRCs and write SHA-256."""
import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZIP_STORED

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('archive', type=Path)
args = parser.parse_args()
root, archive = args.directory.resolve(), args.archive.resolve()
if archive.exists():
    raise SystemExit('Archive already exists; choose a new output name.')
files = []
for p in root.rglob('*'):
    rel = p.relative_to(root)
    if not p.is_file() or rel.parts[0] == 'data' or any(v in rel.parts for v in ('.runtime', '__pycache__', '.git')) or p.suffix == '.pyc':
        continue
    if rel.parts[:3] == ('app','dist','assets'):
        raise RuntimeError('Personal demo assets must not be in the portable build')
    if rel.parts[0] == 'app' and p.suffix in ('.js','.mjs','.py','.json','.html','.txt'):
        text = p.read_text(encoding='utf-8')
        if 'C:\\Users\\Wlos' in text or 'D:\\ComfyUI_LocalTest' in text:
            raise RuntimeError('Local installation path found in ' + str(rel))
    files.append(p)
print(f'Packing {len(files)} files ({sum(p.stat().st_size for p in files)/1024**3:.2f} GiB)...', flush=True)
with ZipFile(archive, 'x', compression=ZIP_DEFLATED, compresslevel=1, allowZip64=True) as z:
    for i, p in enumerate(files):
        z.write(p, (Path(root.name) / p.relative_to(root)).as_posix(),
                compress_type=ZIP_STORED if p.suffix in ('.gguf','.safetensors') else ZIP_DEFLATED)
        if i and i % 5000 == 0:
            print(f'Packed {i}/{len(files)} files', flush=True)
print('Checking complete ZIP integrity...', flush=True)
with ZipFile(archive) as z:
    bad = z.testzip()
    if bad:
        raise RuntimeError('ZIP CRC failed: '+bad)
    assert not any('/data/' in n and n.startswith(root.name+'/data/') for n in z.namelist())
with archive.open('rb') as f:
    sha = hashlib.file_digest(f,'sha256').hexdigest()
archive.with_suffix('.zip.sha256').write_text(sha+'  '+archive.name+'\n',encoding='utf-8')
record = dict(archive=archive.name,bytes=archive.stat().st_size,files=len(files),
              uncompressedBytes=sum(p.stat().st_size for p in files),sha256=sha,zipIntegrity='PASS',personalDataIncluded=False)
archive.with_suffix('.release.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
print(json.dumps(record), flush=True)
