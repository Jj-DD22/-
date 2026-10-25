"""Create a clean, self-contained Windows package; never copies user data."""
import argparse
import json
import shutil
import subprocess
from pathlib import Path

project = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args()
out = Path(args.output).resolve()
if out.exists():
    raise SystemExit('Output already exists; choose a new empty release directory.')
out.mkdir(parents=True)
engine_source = project.parent / 'ComfyUI/ComfyUI_windows_portable'
def copy_tree(source, target, extra=()):
    def ignored(directory, names):
        patterns = ('.git', '__pycache__', '*.pyc') + (extra if Path(directory) == source else ())
        return shutil.ignore_patterns(*patterns)(directory, names)
    shutil.copytree(source, target, ignore=ignored)

print('Copying app and launcher...', flush=True)
(out / 'app').mkdir()
for name in json.loads((project / 'release-files.json').read_text(encoding='utf-8-sig'))['appFiles']:
    shutil.copyfile(project / name, out / 'app' / name)
copy_tree(project / 'dist', out / 'app/dist', ('assets','reference-candidate.png'))
copy_tree(project / 'tests', out / 'app/tests')
(out / 'app/dist/app-config.js').write_text("export const appConfig = {demo:false, draftDatabase:'swap-studio-portable-v1'};\n", encoding='utf-8')
html_path = out / 'app/dist/index.html'
html = html_path.read_text(encoding='utf-8')
for name in ('scene','product','example-result'):
    html = html.replace(f' src="./assets/{name}.png"', '')
html = html.replace('id="loadDemo"', 'id="loadDemo" hidden').replace('id="exampleResult"', 'id="exampleResult" hidden')
html_path.write_text(html, encoding='utf-8')
(out / 'launcher').mkdir()
for name in ('Start.ps1','Stop.ps1','Check.ps1','launch_engine.py','check_package.py'):
    content = (project / 'portable' / name).read_text(encoding='utf-8')
    (out / 'launcher' / name).write_text(content, encoding='utf-8-sig' if name.endswith('.ps1') else 'utf-8')
for english, chinese, script, pause in [('Start.cmd','启动换物工坊.cmd','Start.ps1',False),('Stop.cmd','停止换物工坊.cmd','Stop.ps1',False),('Check.cmd','检查运行环境.cmd','Check.ps1',True)]:
    cmd = '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\\'+script+'"\r\n'
    cmd += 'if errorlevel 1 (\r\n  echo Operation failed. Please read the message above and README.txt.\r\n  pause\r\n  exit /b 1\r\n)\r\n'
    if pause: cmd += 'pause\r\n'
    for name in (english, chinese): (out / name).write_bytes(cmd.encode('ascii'))
for name in ('settings.json','README.txt'):
    shutil.copyfile(project / 'portable' / name, out / name)
shutil.copyfile(out / 'README.txt', out / '先读我.txt')

print('Copying portable Python (may take a few minutes)...', flush=True)
copy_tree(engine_source / 'python_embeded', out / 'runtime/python_embeded')
print('Copying ComfyUI source and GGUF node...', flush=True)
copy_tree(engine_source / 'ComfyUI', out / 'runtime/ComfyUI', ('models','input','output','temp','user','custom_nodes','extra_model_paths.yaml'))
copy_tree(engine_source / 'ComfyUI/custom_nodes/ComfyUI-GGUF', out / 'runtime/ComfyUI/custom_nodes/ComfyUI-GGUF')
(out / 'runtime/ComfyUI/models').mkdir()
(out / 'runtime/node').mkdir()
node = Path(shutil.which('node'))
shutil.copyfile(node, out / 'runtime/node/node.exe')
print('Copying the three models...', flush=True)
manifest = json.loads(Path('D:/ComfyUI_LocalTest/model_manifest.json').read_text(encoding='utf-8-sig'))
clean = []
for item in manifest:
    source = Path(item['path'])
    relative = source.relative_to(Path('D:/ComfyUI_LocalTest/models'))
    target = out / 'models' / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    clean.append({'path':relative.as_posix(),'repo':item['repo'],'source':item['source'],'size':item['size'],'sha256':item['sha256']})
(out / 'models/manifest.json').write_text(json.dumps(clean,indent=2),encoding='utf-8')
(out / 'licenses').mkdir()
for notice in (project / 'portable/licenses').iterdir():
    shutil.copyfile(notice, out / 'licenses' / notice.name)
shutil.copyfile(project / 'portable/THIRD-PARTY.txt', out / 'licenses/THIRD-PARTY.txt')
shutil.copyfile(engine_source / 'ComfyUI/LICENSE', out / 'licenses/ComfyUI-LICENSE.txt')
shutil.copyfile(engine_source / 'ComfyUI/custom_nodes/ComfyUI-GGUF/LICENSE', out / 'licenses/ComfyUI-GGUF-LICENSE.txt')
version = subprocess.check_output([str(node),'--version'],text=True).strip()
(out / 'build-info.json').write_text(json.dumps({'version':'1.0.0','node':version,'platform':'windows-x64','personalAssetsIncluded':False},indent=2),encoding='utf-8')
print('Staged: '+str(out), flush=True)
