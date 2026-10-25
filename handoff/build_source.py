"""Create a source-only handoff from an explicit file allowlist."""
import argparse
import ast
import hashlib
import json
import re
import posixpath
import sys
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args()
output = Path(args.output).resolve()
if output.exists():
    raise SystemExit('Choose a new output file; existing releases are preserved.')

files = {}
for name in json.loads((root / 'release-files.json').read_text(encoding='utf-8-sig'))['appFiles']:
    files[name] = (root / name).read_bytes()
for item in sorted((root / 'dist').iterdir()):
    if item.is_file() and item.suffix in ('.html', '.js', '.css'):
        data = item.read_bytes()
        if item.name == 'app-config.js':
            data = b"export const appConfig={demo:false,draftDatabase:'swap-studio-source'};\n"
        if item.name == 'index.html':
            text = data.decode('utf-8')
            text = re.sub(r' src="\./assets/[^"]*"', '', text)
            text = text.replace('id="loadDemo"', 'id="loadDemo" hidden').replace('id="exampleResult"', 'id="exampleResult" hidden')
            data = text.encode('utf-8')
        files['dist/' + item.name] = data
for directory in ('tests', 'shared', 'portable', 'handoff'):
    for item in sorted((root / directory).iterdir()):
        if item.is_file() and item.suffix in ('.py', '.mjs', '.ps1', '.json', '.txt') and not item.name.endswith('.local.json'):
            files[directory + '/' + item.name] = item.read_bytes()

for item in sorted((root / 'portable/licenses').glob('*.txt')):
    files['portable/licenses/' + item.name] = item.read_bytes()

# Include imports nested inside image-processing functions, not only top-level imports.
python_imports = set()
for name, data in files.items():
    if not name.endswith('.py') or '/' in name:continue
    for node in ast.walk(ast.parse(data.decode('utf-8'))):
        if isinstance(node, ast.Import):
            python_imports.update(alias.name.split('.')[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            python_imports.add(node.module.split('.')[0])
python_external = python_imports - set(sys.stdlib_module_names) - {Path(name).stem for name in files if name.endswith('.py')} - {'torch', 'mobile_sam'}
distribution_names = {'PIL': 'pillow', 'numpy': 'numpy', 'scipy': 'scipy'}
assert python_external <= distribution_names.keys(), f'Unmapped Python dependencies: {python_external - distribution_names.keys()}'
declared = {re.split(r'[<=>!~\[]', line.strip())[0].lower() for line in files['requirements.txt'].decode().splitlines() if line.strip() and not line.startswith('#')}
required = {distribution_names[name] for name in python_external}
assert required <= declared, f'Missing Python requirements: {required - declared}'
relative_imports = 0
for name, data in files.items():
    if not name.endswith(('.js', '.mjs')):
        continue
    for target in re.findall(r'''(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]''', data.decode('utf-8')):
        if target.startswith('.'):
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
            assert resolved in files, f'Missing JavaScript module: {name} -> {target}'
            relative_imports += 1
        else:
            assert target.startswith('node:'), f'Undeclared JavaScript package: {target}'

output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name, data in files.items():
        archive.writestr('SwapStudio-Source/' + name, data)
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert len(archive.infolist()) == len(files)
    assert not any(name.endswith(('.png', '.jpg', '.webp', '.gguf', '.safetensors', '.exe', '.dll')) for name in archive.namelist())
    assert not any(name.endswith('/.env') or '/data/' in name or '/node_modules/' in name for name in archive.namelist())

manifest = {
    'archive': output.name, 'bytes': output.stat().st_size,
    'uncompressedBytes': sum(map(len, files.values())), 'fileCount': len(files),
    'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
    'personalDataIncluded': False, 'modelsIncluded': False, 'runtimeIncluded': False,
    'targetSystem': None, 'zipIntegrity': 'PASS',
    'dependencyAudit': {'pythonDistributions': sorted(required), 'relativeJavaScriptImports': relative_imports, 'status': 'PASS'},
    'files': [{'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in files.items()]
}
output.with_suffix('.manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({key: value for key, value in manifest.items() if key != 'files'}, ensure_ascii=True))
