"""Relocatable, offline ComfyUI entry point for the Windows package."""
import json
import os
import runpy
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
engine = root / 'runtime/ComfyUI'
data = root / 'data'
for name in ('input', 'output', 'temp', 'user'):
    (data / name).mkdir(parents=True, exist_ok=True)
threads = min(6, max(1, (os.cpu_count() or 2) // 2))
os.environ.update(OMP_NUM_THREADS=str(threads), MKL_NUM_THREADS=str(threads),
                  HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
import torch
torch.set_num_threads(threads)
torch.set_num_interop_threads(1)
requested = os.environ.get('SWAP_DEVICE', 'auto')
if requested not in ('auto', 'cpu', 'cuda'):
    raise ValueError('settings.json device must be auto, cpu or cuda')
device = 'cpu'
reason = 'CPU mode selected'
if requested != 'cpu':
    try:
        if not torch.cuda.is_available():
            raise RuntimeError('Compatible NVIDIA driver/GPU was not detected')
        test = torch.ones(8, device='cuda') * 2
        torch.cuda.synchronize()
        del test
        torch.cuda.empty_cache()
        device, reason = 'cuda', torch.cuda.get_device_name(0)
    except Exception as error:
        if requested == 'cuda':
            raise RuntimeError('CUDA failed. Set device to cpu in settings.json. ' + str(error))
        reason = str(error)
print(json.dumps({'device': device, 'detail': reason, 'threads': threads}), flush=True)
# JSON is valid YAML, and safely quotes spaces and non-ASCII paths.
model_config = data / 'models.yaml'
model_config.write_text(json.dumps({'swap_studio': {'base_path': str(root / 'models'),
    'diffusion_models': 'diffusion_models', 'text_encoders': 'text_encoders', 'vae': 'vae'}}), encoding='utf-8')
os.chdir(engine)
sys.path.insert(0, str(engine))
sys.argv = [str(engine / 'main.py'), '--cache-none', '--offline', '--listen', '127.0.0.1',
    '--port', os.environ['SWAP_ENGINE_PORT'], '--disable-auto-launch',
    '--disable-all-custom-nodes', '--whitelist-custom-nodes', 'ComfyUI-GGUF',
    '--extra-model-paths-config', str(model_config),
    '--output-directory', str(data / 'output'), '--input-directory', str(data / 'input'),
    '--temp-directory', str(data / 'temp'), '--user-directory', str(data / 'user')]
if device == 'cpu':
    sys.argv.append('--cpu')
runpy.run_path(str(engine / 'main.py'), run_name='__main__')
