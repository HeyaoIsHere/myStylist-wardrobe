# myStylist — Digital Wardrobe

> Know your wardrobe. Understand your style. Dress better.

A self-hosted digital wardrobe + outfit sticker-board app: upload photos of your own clothes, the AI cuts them out (GroundingDINO + SAM2), each piece becomes a transparent sticker, and you can freely compose outfits on a board and save them. Bilingual UI (Chinese / English).
![image](https://github.com/HeyaoIsHere/myStylist-wardrobe/demo.gif)
## Features

| Feature | Description |
|---|---|
| Digital wardrobe | Upload clothing photos, local AI matting (detect → mask → mask editor), save with name + category |
| Smart cut-out | Local Python service (GroundingDINO-tiny + SAM2-tiny) with a live progress stream; falls back to manual painting automatically when the service is unavailable |
| Mask editor | Meitu-style green mask: brush / eraser / undo / redo, adjustable brush size |
| Sticker board | `/stylist` — wardrobe on the left (search, delete), board on the right: drag stickers, resize, rotate (snaps to 45°), save outfits |
| Saved outfits | Profile shows the 3 most recent, `/profile/saved` shows all, with delete |
| Bilingual | 中文 / English, driven by the `lang` cookie |

## Tech Stack

- **Frontend**: Next.js 16 (App Router, Turbopack) + React 19 + Tailwind CSS v4 + TypeScript
- **Data**: JSON file store (`data/store.json`, auto-created and auto-migrated at runtime), no external database
- **AI matting**: Python + FastAPI sidecar (`tools/matting/`), GroundingDINO-tiny detection + SAM2-tiny segmentation; GPU (CUDA) optional, CPU-only works too

## Project Structure

```
├── src/
│   ├── app/                    # Next.js App Router pages + API routes
│   │   ├── page.tsx            # / home
│   │   ├── stylist/            # /stylist wardrobe + sticker board (core page)
│   │   ├── wardrobe/           # /wardrobe (redirect), /wardrobe/add (upload + matting), /wardrobe/[id]
│   │   ├── profile/            # /profile, /profile/saved (all saved outfits)
│   │   ├── outfit/[id]/        # saved outfit detail
│   │   └── api/                # wardrobe / outfits / ai-classify / reset routes
│   ├── components/             # UI (MattingEditor, CutoutEditor, ConfirmDialog, …)
│   ├── i18n/                   # zh.ts / en.ts dictionaries (no hardcoded copy in components)
│   └── lib/
│       ├── db/                 # store.ts (JSON repository, auto-creates dirs & migrates) + seed.ts
│       ├── services/ai.ts      # AI abstraction layer (classification hints)
│       ├── client/             # client-side image helpers (upload compression, sticker rendering)
│       └── types.ts            # data models
├── tools/matting/              # AI matting Python service (see its README)
├── scripts/                    # asset generation/fetch scripts (optional, not required at runtime)
├── data/                       # created at runtime (gitignored, never committed)
└── public/uploads/             # matting output (created at runtime, gitignored, never committed)
```

## Getting Started

### 1. Frontend

Requires Node.js ≥ 20.

```bash
npm install      # first time only
npm run dev      # → http://localhost:3000
```

On first launch, `data/` and `public/uploads/` are created automatically. The wardrobe starts empty — upload your own clothes to get going.

### 2. AI matting service (optional, recommended)

Requires Python ≥ 3.10. One command on Windows:

```bat
tools\matting\run.bat
```

On first run it: creates `.venv` → installs dependencies (torch ~2.5GB) → downloads model weights (~800MB) → serves `http://127.0.0.1:8001`.

- **China networks**: set `set HF_ENDPOINT=https://hf-mirror.com` before running to download models via the HF mirror.
- **GPU acceleration**: the default CPU torch works (slower); for CUDA torch on Windows, install from the SJTU wheel index (see `tools/matting/README.md`).
- **The app works without this service**: after uploading, it automatically falls back to manual painting mode — brush over the part to keep.

Model weights are **not distributed with this repo** — `download-models.py` downloads everything on first run.

## Environment Variables (all optional)

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_MATTING_URL` | `http://localhost:8001` | Matting service base URL |
| `MYSTYLIST_MODELS_DIR` | `tools/matting/models` | Model storage directory |
| `MYSTYLIST_UPLOAD_DIR` | `public/uploads` | Matting output directory |
| `HF_ENDPOINT` | (official) | Use `https://hf-mirror.com` in China |

See `.env.example`.

## Data & Privacy

- All user data (wardrobe, outfits) lives in local `data/store.json`, **excluded via .gitignore**.
- Uploaded photos and cut-out results live in local `public/uploads/`, **also excluded from version control**.
- This repo contains no user photos, no runtime data, no model weights, no API keys.

## License

(Unspecified — add a LICENSE file if you plan to open-source this project)
