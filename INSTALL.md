# DICOMclaw Installation Guide

## Prerequisites

- **OS**: Linux (Ubuntu 20.04+ recommended)
- **GPU**: NVIDIA GPU with 8+ GB VRAM (CUDA 11.8+ for PyTorch)
- **Node.js**: v20+ (`nvm install 20`)
- **Python**: 3.10+ (via conda or system)
- **Disk**: ~10 GB for model weights + dependencies

## 1. Clone & Install Node.js Dependencies

```bash
git clone <repo-url> DICOMclaw
cd DICOMclaw
npm install
cd web-ui && npm install && cd ..
```

## 2. Python Environment

Create a dedicated conda environment:

```bash
conda create -n dicomclaw python=3.10 -y
conda activate dicomclaw
```

### Core Python packages

```bash
pip install nibabel pydicom scipy scikit-image SimpleITK pandas einops highdicom
```

### PyTorch (with CUDA)

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
```

Verify GPU:

```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

### TotalSegmentator

```bash
pip install TotalSegmentator
```

Verify:

```bash
python -c "from totalsegmentator.python_api import totalsegmentator; print('OK')"
```

## 3. AutoPET-3 Model (LesionTracer)

The AutoPET-3 model is a modified nnU-Net v2 with a custom dual-headed architecture for lesion + organ segmentation.

### 3a. Install the modified nnU-Net

**Important**: This replaces any existing `nnunetv2` package.

```bash
cd /path/to/parent  # e.g., $HOME
git clone https://github.com/MIC-DKFZ/autopet-3-submission.git autopet_repo
cd autopet_repo
pip install -e .
```

Verify:

```bash
python -c "from nnunetv2.training.nnUNetTrainer.autoPET3_Trainer import autoPET3_Trainer; print('OK')"
```

### 3b. PyTorch compatibility fix

If using PyTorch >= 2.6, patch `torch.load` in the predictor:

```bash
# File: autopet_repo/nnunetv2/inference/predict_from_raw_data.py
# Find the line:
#   checkpoint = torch.load(..., map_location=torch.device('cpu'))
# Add weights_only=False:
#   checkpoint = torch.load(..., map_location=torch.device('cpu'), weights_only=False)
```

### 3c. Download model weights

Download from Zenodo (3.6 GB):

```bash
cd DICOMclaw/weights
wget "https://zenodo.org/records/14007247/files/autoPET-3-LesionTracer.zip?download=1" \
     -O autoPET-3-LesionTracer.zip
unzip autoPET-3-LesionTracer.zip
rm autoPET-3-LesionTracer.zip  # optional cleanup
```

Expected structure:

```
weights/
  Dataset222_AutoPETIII_2024/
    autoPET3_Trainer__nnUNetResEncUNetLPlansMultiTalent__3d_fullres_bs3/
      dataset.json
      plans.json
      dataset_fingerprint.json
      fold_0/checkpoint_final.pth
      fold_1/checkpoint_final.pth
      fold_2/checkpoint_final.pth
      fold_3/checkpoint_final.pth
      fold_4/checkpoint_final.pth
```

Verify the model loads:

```bash
cd DICOMclaw
python -c "
from analysis.utils.autopet_wrapper import find_model_path
path = find_model_path('weights')
print('Model:', path)
assert path is not None, 'Weights not found!'
"
```

## 4. DICOM Data

Place DICOM studies in `data/studies/`:

```
data/studies/
  PatientName-or-ID/
    *.dcm
```

The auto-indexer runs on server startup and scans all subdirectories. Each study needs at minimum a CT series; PET series are required for SUV and lesion analysis.

## 5. Environment Configuration

Create `.env` in the project root:

```bash
cat > .env << 'EOF'
# OpenRouter API (required)
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=z-ai/glm-5
VISION_MODEL=moonshotai/kimi-k2.5
CHAT_MODEL=google/gemini-3.1-flash-lite-preview

# Server
PORT=8411
HOST=0.0.0.0

# Agent
MAX_CONCURRENT=3
AGENT_TIMEOUT=3600000

# Logging
LOG_LEVEL=info
EOF
```

### Model configuration

| Variable | Purpose | Example |
|---|---|---|
| `OPENROUTER_MODEL` | Agent reasoning (ReAct loop) | `z-ai/glm-5`, `anthropic/claude-sonnet-4` |
| `VISION_MODEL` | Image interpretation skill | `moonshotai/kimi-k2.5`, `google/gemini-2.5-flash-preview` |
| `CHAT_MODEL` | Direct chat mode (no agent) | `google/gemini-3.1-flash-lite-preview` |

All models can be changed at runtime via the Settings UI (gear icon).

## 6. Build & Run

```bash
# Build backend + frontend
npm run build
npm run build:ui

# Start server
npm start
```

The server starts on `http://localhost:8411`.

### Development mode

```bash
# Terminal 1: Backend with hot reload
npm run dev

# Terminal 2: Frontend with HMR
npm run dev:ui
```

Frontend dev server runs on port 5173 and proxies API calls to 8411.

## 7. Verify Installation

1. Open `http://localhost:8411` in browser
2. Select a study from the worklist (left sidebar)
3. The DICOM viewer should load CT/PET/Fusion/MIP viewports
4. Switch to **Agent** mode and send "Segment the liver and calculate SUV"
5. Verify TotalSegmentator runs and overlay appears on the viewer
6. Send "Detect lesions" to verify AutoPET-3 model loads (check server logs for "Using folds: [0, 1, 2, 3, 4]")
7. Switch to **Chat** mode and ask about the current image — should get VLM response based on viewport snapshots

## Troubleshooting

### "No nnUNet model weights found"

- Check `weights/` directory contains the extracted model folder
- Run: `python -c "from analysis.utils.autopet_wrapper import find_model_path; print(find_model_path('weights'))"`

### CUDA out of memory

- The model uses 4mm isotropic resampling to reduce memory usage
- Ensure `PYTORCH_CUDA_ALLOC_CONF=max_split_size_mb:128` is set (automatic in wrapper)
- Try closing other GPU processes: `nvidia-smi`

### torch.load UnpicklingError

- PyTorch >= 2.6 requires `weights_only=False` for legacy checkpoints
- Apply the patch in step 3b above

### TotalSegmentator slow on first run

- First run downloads ~1.5 GB of TotalSegmentator weights
- Subsequent runs use cached weights in `~/.totalsegmentator/`

### Port already in use

```bash
lsof -ti:8411 | xargs kill -9
npm start
```

### Cornerstone "context is null" error

- Some studies may briefly show a WebGL context error on load. This auto-dismisses after a few seconds and does not affect functionality.
- If persistent, try refreshing the page or using a different browser (Chrome/Edge recommended).

### Overlay contours in wrong position

- Each overlay (AutoPET lesion mask, TotalSegmentator organ mask) uses its own spatial reference for positioning
- If contours appear misaligned, re-run the analysis to regenerate the mask with correct affine metadata
- Check that the CT series loaded in the viewer matches the series used for segmentation
