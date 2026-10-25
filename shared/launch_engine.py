"""One private ComfyUI engine for all browsers; uses existing runtime/models."""
import json
import os
from pathlib import Path
import runpy
import sys

engine = Path(os.environ['SWAP_ENGINE_DIR'])
data = Path(os.environ['SWAP_SHARED_DATA']) / 'engine'
for name in ('input', 'output', 'temp', 'user'):
    (data / name).mkdir(parents=True, exist_ok=True)
threads = max(1, min(8, int(os.environ.get('SWAP_CPU_THREADS', '4'))))
os.environ.update(OMP_NUM_THREADS=str(threads), MKL_NUM_THREADS=str(threads),
                  HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
import torch
torch.set_num_threads(threads)
torch.set_num_interop_threads(1)
requested = os.environ.get('SWAP_DEVICE', 'auto')
if requested not in ('auto', 'cpu', 'cuda'):
    raise ValueError('device must be auto, cpu or cuda')
device = 'cpu'
if requested != 'cpu':
    try:
        if not torch.cuda.is_available():
            raise RuntimeError('No compatible NVIDIA GPU detected')
        check = torch.ones(8, device='cuda') * 2
        torch.cuda.synchronize()
        del check
        torch.cuda.empty_cache()
        device = 'cuda'
    except Exception as error:
        if requested == 'cuda':
            raise RuntimeError('CUDA check failed: ' + str(error))
        print('Using CPU: ' + str(error), flush=True)
print(json.dumps({'device': device, 'threads': threads}), flush=True)
model_config = data / 'models.yaml'
model_config.write_text(json.dumps({'shared_studio': {
    'base_path': os.environ['SWAP_MODEL_DIR'], 'diffusion_models': 'diffusion_models',
    'text_encoders': 'text_encoders', 'vae': 'vae'}}), encoding='utf-8')
os.chdir(engine)
sys.path.insert(0, str(engine))
sys.argv = [str(engine / 'main.py'), '--cache-none', '--offline', '--listen', '127.0.0.1',
    '--port', os.environ['SWAP_ENGINE_PORT'], '--disable-auto-launch',
    '--disable-all-custom-nodes', '--whitelist-custom-nodes', 'ComfyUI-GGUF',
    '--extra-model-paths-config', str(model_config), '--output-directory', str(data / 'output'),
    '--input-directory', str(data / 'input'), '--temp-directory', str(data / 'temp'),
    '--user-directory', str(data / 'user')]
if device == 'cpu':
    sys.argv.append('--cpu')
runpy.run_path(str(engine / 'main.py'), run_name='__main__')
