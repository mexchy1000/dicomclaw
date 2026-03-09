# DICOMclaw

Chat-driven PET/CT quantitative analysis platform. Combines an LLM-powered ReAct agent with a full DICOM viewer for interactive medical image analysis.

## Features

- **DICOM Viewer** — Cornerstone3D-based 2x2 grid (CT / PET / Fusion / MIP) with W/L presets, PET colormaps, slice sync, and orientation switching
- **VOI Overlay** — Segmentation contours rendered as SVG overlays on CT/Fusion viewports, with label badges and quantitative popups
- **Interactive VOI Drawing** — Draw spherical VOIs on PET/Fusion, apply SUV threshold refinement, drag to reposition
- **Agent Mode** — ReAct agent with plan approval UI; auto-discovers analysis skills with markdown-based guides
- **Chat Mode** — Direct VLM conversation with current viewport snapshots (no agent loop)
- **@ VOI Mention** — Reference VOIs in chat with autocomplete; VOI context injected into messages
- **Lesion Detection** — AutoPET-3 (nnU-Net) full-body lesion segmentation with SUV quantification
- **Organ Segmentation** — TotalSegmentator-based organ segmentation with viewer overlay
- **Texture Analysis** — Radiomics-style feature extraction (GLCM, shape, first-order) with configurable parameters
- **Report Generation** — Structured analysis reports from accumulated results

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  React 18 + Vite (Cornerstone3D viewer + Chat UI)   │
└────────────────────┬────────────────────────────────┘
                     │ Socket.io + REST
┌────────────────────┴────────────────────────────────┐
│  Node.js (Express + Socket.io) — port 8411          │
│  SQLite (better-sqlite3) · WADO-URI · VLM client    │
└────────────────────┬────────────────────────────────┘
                     │ subprocess (stdin/stdout/stderr)
┌────────────────────┴────────────────────────────────┐
│  Python ReAct Agent (analysis/local_agent.py)        │
│  10 auto-discovered skills with markdown guides      │
└─────────────────────────────────────────────────────┘
```

- **Backend**: Node.js (Express + Socket.io) on port 8411
- **Frontend**: React 18 + Vite (dev on 5173, production served by Express)
- **Agent**: Python ReAct loop spawned per message, communicates via `[REACT:*]` stderr markers
- **LLM**: OpenRouter API — separate models for agent, vision, and chat
- **DB**: SQLite at `data/dicomclaw.db`
- **Viewer**: Cornerstone3D v4.18 with VolumeViewports

## Directory Structure

```
src/                  # Node.js TypeScript backend
  channels/           #   Express routes + Socket.io handlers
  dicom/              #   WADO-URI provider
analysis/             # Python agent + skills + utils
  skills/             #   Auto-discovered analysis skills (BaseSkill subclasses)
  skills/guides/      #   Markdown skill guides (injected into agent prompt)
  utils/              #   DICOM processing, SUV, MIP, segmentation, contours
  bootstrap/          #   DICOM study indexer
web-ui/               # React frontend
  src/hooks/          #   React hooks (viewer, overlays, chat, settings, etc.)
  src/components/     #   UI components (viewer, chat, panels, worklist)
data/studies/         # DICOM data (gitignored)
results/              # Per-study analysis outputs (plots, tables, masks)
weights/              # ML model weights (gitignored)
```

## Quick Start

```bash
# Install dependencies
npm install
cd web-ui && npm install && cd ..

# Configure
cp .env.example .env   # edit with your OpenRouter API key

# Build & run
npm run build && npm run build:ui
npm start              # http://localhost:8411
```

See [INSTALL.md](INSTALL.md) for full setup including Python environment, GPU, and model weights.

## Commands

```bash
npm run build         # Compile TypeScript backend
npm run build:ui      # Build React frontend
npm start             # Run server (port 8411)
npm run dev           # Dev server with hot reload
npm run dev:ui        # Vite dev server (port 5173, proxies to 8411)
```

## Configuration

Environment variables (`.env`):

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | (required) | OpenRouter API key |
| `OPENROUTER_MODEL` | `z-ai/glm-5` | Agent text model |
| `VISION_MODEL` | `moonshotai/kimi-k2.5` | Vision model for image interpretation |
| `CHAT_MODEL` | `google/gemini-3.1-flash-lite-preview` | Chat mode model |
| `PORT` | `8411` | Server port |
| `AGENT_TIMEOUT` | `3600000` | Agent subprocess timeout (ms) |

All models are configurable via the Settings UI at runtime.

## Skills

Skills are auto-discovered from `analysis/skills/*.py`. Each extends `BaseSkill` and has a corresponding markdown guide in `analysis/skills/guides/` that controls agent behavior:

| Skill | Description |
|---|---|
| `scan_dicom` | Scan studies, extract metadata, select best CT/PET series |
| `generate_mip` | Generate MIP images from PET series (4 angles) |
| `calc_suv` | Calculate organ SUV statistics via TotalSegmentator |
| `segment_organ` | Organ segmentation (TotalSegmentator) with viewer overlay |
| `quantify_lesion` | AutoPET-3 lesion detection with SUV quantification |
| `extract_texture` | Radiomics texture features (GLCM, shape, first-order) |
| `analyze_voi` | Detailed VOI analysis (histogram, percentiles, profiles) |
| `compare_studies` | Cross-timepoint lesion comparison |
| `vision_interpret` | VLM-based image interpretation |
| `generate_report` | Structured analysis report from accumulated results |

### Skill Guides

Each skill has a markdown guide (`analysis/skills/guides/<skill_name>.md`) that is automatically loaded into the agent's system prompt. These guides control:
- When and how the agent invokes each skill
- Required and optional parameters with defaults
- Workflow patterns and decision rules
- Error handling guidance

Edit the markdown files to adjust agent behavior without changing code.

## Agent Communication Protocol

Python agent communicates with Node.js via stderr markers:

- `[REACT:THOUGHT]` — Agent reasoning step
- `[REACT:ACTION]` — Skill invocation
- `[REACT:OBSERVATION]` — Skill result
- `[REACT:PLAN]` — Triggers plan approval UI in frontend
- `[REACT:OVERLAY]{"study_uid":...}` — VOI overlay for viewer
- `[REACT:PROGRESS]{"skill":...,"percent":...}` — Progress bar update

## DICOM Data

Place DICOM studies in `data/studies/` and start the server. The auto-indexer runs on startup, scans all subdirectories, and extracts clinical context from DICOM headers. Studies appear in the worklist sidebar.

## License

This project is licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) (Creative Commons Attribution-NonCommercial 4.0).

### Third-Party Licenses

| Component | License | Copyright |
|---|---|---|
| [nnU-Net v2](https://github.com/MIC-DKFZ/nnUNet) | Apache 2.0 | DKFZ, Heidelberg |
| [AutoPET-3 LesionTracer](https://github.com/MIC-DKFZ/autopet-3-submission) | Apache 2.0 | DKFZ, Heidelberg |
| [TotalSegmentator](https://github.com/wasserth/TotalSegmentator) | Apache 2.0 | Jakob Wasserthal |
| [Cornerstone3D](https://github.com/cornerstonejs/cornerstone3D) | MIT | Open Health Imaging Foundation |
| [PyTorch](https://github.com/pytorch/pytorch) | BSD-3-Clause | Meta Platforms |
| [scikit-image](https://github.com/scikit-image/scikit-image) | BSD-3-Clause | scikit-image team |

See [LICENSE](LICENSE) for full details.
