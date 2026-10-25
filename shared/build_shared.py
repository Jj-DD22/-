"""Build a small host app update. Never copies models, credentials or user images."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args()
output = Path(args.output).resolve()
if output.exists():
    raise SystemExit('Output already exists. Choose a new name.')
files = [root / name for name in json.loads((root / 'release-files.json').read_text(encoding='utf-8-sig'))['appFiles']]
files += [root / name for name in ('Start-Shared.cmd', 'Stop-Shared.cmd',
    'Allow-LAN.cmd', '启动共享网页版.cmd', '停止共享网页版.cmd', '允许局域网访问.cmd')]
files += [p for p in (root / 'dist').iterdir() if p.is_file() and p.suffix in ('.html', '.js', '.css')]
files += [root / 'shared' / name for name in ('Start.ps1', 'Stop.ps1', 'Firewall.ps1', 'Config.ps1',
    'launch_engine.py', 'settings.json', 'README.txt')]
files = list(dict.fromkeys(files))
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED, compresslevel=7) as archive:
    for file in files:
        data = file.read_bytes()
        if file.name == 'app-config.js':
            data = b"export const appConfig={demo:false,draftDatabase:'swap-shared-fallback'};\n"
        if file.name == 'index.html':
            import re
            data = re.sub(r' src="\./assets/[^"]*"', '', data.decode('utf8')).encode('utf8')
        archive.writestr('SwapStudio-Shared/' + file.relative_to(root).as_posix(), data)
    archive.writestr('SwapStudio-Shared/先读我.txt', (root / 'shared/README.txt').read_bytes())
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    names = archive.namelist()
    assert not any(part in name for name in names for part in ('settings.local', 'assets/', 'access-code', 'sessions.json', '.runtime', '.shared-data'))
manifest = {'archive': output.name, 'bytes': output.stat().st_size, 'files': len(names),
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'personalDataIncluded': False,
            'modelsIncluded': False, 'runtimeIncluded': False, 'zipIntegrity': 'PASS'}
output.with_suffix('.release.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps(manifest, ensure_ascii=False))
