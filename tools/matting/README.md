# Matting service (GroundingDINO + SAM2)

Local Python sidecar that cuts clothing out of photos:

1. **GroundingDINO-tiny** (official IDEA-Research weights, run via transformers —
   the official repo needs a CUDA-toolkit compile which is not required here)
   detects the clothing region and returns a bounding box.
2. **SAM2-tiny** (official facebookresearch/sam2-hiera-tiny weights) turns the
   box into a precise mask (3 candidates scored by coverage/model score/area).
3. The mask is exported as a **green overlay PNG at the ORIGINAL photo
   resolution** (RGB = green tint, alpha = keep region) to `public/uploads/`.
   The final 512×512 transparent cutout is computed **client-side** by
   `src/components/ui/CutoutEditor.tsx` (crop → scale → centre), so the
   browser editor can paint/erase on the mask before cutting.

If the local pipeline fails, the service still streams
`{"stage":"manual"}` with an empty-mask overlay — the browser falls back to
manual painting on the original photo. If the service itself is unreachable,
the frontend switches to the same manual mode automatically.

## Start (one command)

```
tools\matting\run.bat
```

First run: creates `.venv`, installs torch (~2.5GB), downloads models
(~800MB via hf-mirror), then serves `http://127.0.0.1:8001`.
Set `HF_ENDPOINT=https://hf-mirror.com` before first run on China networks.

## Device tiers (auto)

The service picks the best working tier at startup and prints it:

| tier  | DINO      | SAM2      | speed     |
|-------|-----------|-----------|-----------|
| gpu   | CUDA fp32 | CUDA      | seconds   |
| mixed | CPU       | CUDA      | ~5-10s    |
| cpu   | CPU       | CPU       | ~15-30s   |

CPU torch is what PyPI mirrors install by default. For CUDA on Windows, install
torch + torchvision from the SJTU wheel index, e.g.
`pip install torch torchvision --index-url https://mirror.sjtu.edu.cn/pytorch-wheels/cu126`
(see `requirements.txt` for pinned versions).

## API

- `GET /health` → `{"ok":true,"tier":"gpu"}` (only answers once models are loaded)
- `POST /matting` `{"image":"<base64 jpeg or data URL>"}` → NDJSON stream:

```
{"stage":"detect"}
{"stage":"mask"}
{"stage":"normalize"}
{"stage":"done","url":"/uploads/abc123.png","categoryHint":"tops"}
```

On local-pipeline failure:
`{"stage":"manual","url":"/uploads/abc123.png","categoryHint":null}`
(empty-mask overlay — paint manually).
On hard error: `{"stage":"error","message":"..."}`.

The Next.js app calls this from the matting page (`NEXT_PUBLIC_MATTING_URL`,
default `http://localhost:8001`).

## Smoke test without the browser

```bat
tools\matting\.venv\Scripts\python tools\matting\test_pipeline.py path\to\photo.jpg
```

Prints the NDJSON stages as they arrive — handy for checking the service is up.
