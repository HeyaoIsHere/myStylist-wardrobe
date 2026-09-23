# myStylist — Digital Wardrobe & AI Outfit Agent

> Know your wardrobe. Understand your style. Dress better.

A self-hosted digital wardrobe + outfit sticker-board app with an AI outfit-planning agent. Upload photos of your own clothes, the AI cuts them out (GroundingDINO + SAM2), each piece becomes a transparent sticker, and you can freely compose outfits — or let the Agent plan them for you. Bilingual UI (Chinese / English).

![demo](demo.gif)

## Features

| Feature | Description |
|---|---|
| Digital wardrobe | Upload clothing photos, local AI matting (detect → mask → mask editor), save with name + category |
| Smart cut-out | Local Python service (GroundingDINO-tiny + SAM2-tiny) with live progress stream; falls back to manual painting when the service is unavailable |
| Mask editor | Meitu-style green mask: brush / eraser / undo / redo, adjustable brush size |
| Sticker board | `/stylist` — wardrobe on the left (search, delete), board on the right: drag, resize, rotate (snaps to 45°), save outfits |
| Saved outfits | Profile shows the 3 most recent, `/profile/saved` shows all, with delete |
| **AI Outfit Agent** | `/agent` — conversational outfit planner. Describe what you need (occasion, weather, mood) and the agent searches your wardrobe, composes looks, and validates them before answering |
| Bilingual | 中文 / English, driven by the `lang` cookie |

## Tech Stack

- **Frontend**: Next.js 16 (App Router, Turbopack) + React 19 + Tailwind CSS v4 + TypeScript
- **Data**: JSON file store (`data/store.json`, auto-created and auto-migrated at runtime), no external database
- **AI matting**: Python + FastAPI sidecar (`tools/matting/`), GroundingDINO-tiny + SAM2-tiny; GPU (CUDA) optional, CPU-only works too
- **AI Agent**: Bounded tool-use agent orchestrating retrieval → composition → validation, with a deterministic policy (offline) or LLM decision layer (DeepSeek / OpenAI-compatible)
- **Embeddings**: Local (deterministic, offline, zero keys) or OpenAI-compatible hosted endpoint

---

## Getting Started

The project has **three services**, but two of them run inside the Next.js process. You only need to start **two terminal processes** in total.

### Service overview

| Service | Where it runs | Port | Purpose |
|---|---|---|---|
| **Next.js Web App** | Node.js (frontend + API routes) | `3000` | The website, wardrobe CRUD, sticker board, Agent UI, recommend API, retrieval API, metadata API |
| **Agent API** | Inside Next.js (server-side) | same 3000 | `/api/agent/recommend` — the agent runs in-process, no separate server needed |
| **Matting Service** | Python FastAPI sidecar | `8001` | `/matting` — AI clothing cut-out (GroundingDINO + SAM2). Optional — the app falls back to manual painting when it's down |

---

### 1. Start the Next.js Web App (includes Agent API)

Requires **Node.js ≥ 20**.

```bash
npm install      # first time only
npm run dev      # → http://localhost:3000
```

On first launch, `data/` and `public/uploads/` are created automatically. The wardrobe starts empty — upload your own clothes to get going.

The Agent API is available at `POST /api/agent/recommend` and the test panel at `/agent`.

---

### 2. Start the AI Matting Service (optional, recommended)

Requires **Python ≥ 3.10**.

**Windows (one command):**

```bat
tools\matting\run.bat
```

**Manual (any OS):**

```bash
# Create venv and install deps (first time only)
python -m venv tools/matting/.venv
tools/matting/.venv/Scripts/pip install -r tools/matting/requirements.txt

# Start the service
tools/matting/.venv/Scripts/python -m uvicorn service:app --app-dir tools/matting --host 0.0.0.0 --port 8001
```

On first run it downloads model weights (~800MB) and serves at `http://localhost:8001`.

- **China networks**: set `HF_ENDPOINT=https://hf-mirror.com` before running to download models via the HF mirror.
- **GPU acceleration**: auto-detects NVIDIA GPU and installs CUDA torch; without a GPU it falls back to CPU (slower, ~15–30s per photo).
- **The app works without this service**: after uploading, it automatically falls back to manual painting mode.

Model weights are **not distributed with this repo** — `download-models.py` downloads everything on first run.

---

### Quick Start Cheat Sheet

```bash
# Terminal 1 — matting service
tools\matting\run.bat

# Terminal 2 — web app + agent API
npm run dev

# Open in browser
#  http://localhost:3000          — home
#  http://localhost:3000/agent    — AI outfit agent panel
#  http://localhost:3000/stylist  — sticker board
```

---

## AI Outfit Agent

The agent is a **bounded tool-use outfit planner**. Given a natural-language request (e.g. "I need something for a rainy office day"), it searches your wardrobe, composes a look, validates it, and returns a grounded result — never inventing clothes you don't own.

### How it works

```
User request
    ↓
Decision layer (policy or LLM)  ──{ action, args }──▶  allowlist + zod validation
    ↓
Tool execution (existing seams: retrieval / compose / validate)
    ↓
Updated structured state  →  next decision  …  bounded by max-iterations + deadline
```

### Six allowlisted tools

| Tool | What it does | Backed by |
|---|---|---|
| `search_wardrobe` | Semantic search over your wardrobe with structural constraints | `src/lib/retrieval/` |
| `get_weather` | Gets current weather (mock for now) | `src/lib/agent/weather.ts` |
| `get_user_preferences` | Aggregates style signals from liked items | `src/lib/agent/prefs.ts` |
| `generate_outfit` | Composes a full outfit from candidate items | `src/lib/recommend/compose.ts` |
| `validate_outfit` | Runs deterministic + semantic validation | `src/lib/recommend/validate.ts` + `semantic.ts` |
| `finish` | Returns the final answer | — |

### Grounding invariants (enforced by the runner, never by the decision layer)

- Every recommended item resolves to a **live** catalog entry — no ghost IDs
- `generate_outfit` only picks IDs from the previous `search_wardrobe` result
- Deterministic validation is **always** re-run on the final look by the runner — the agent cannot bypass it
- Hard constraints are frozen and only ever added to, never removed

### Decision layer

Controlled by the same `AI_PROVIDER` env var the rest of the app uses:

| Provider | Mode | Use case |
|---|---|---|
| `mock` (default) | Deterministic offline policy | Local dev, evaluations, golden set — zero keys, fully reproducible |
| `deepseek` (or any OpenAI-compatible) | Hosted LLM decision-making | Production — set `DEEPSEEK_API_KEY` and `AI_TEXT_MODEL` |

### Agent API endpoint

```
POST /api/agent/recommend
Content-Type: application/json

{ "request": "casual weekend brunch look" }
```

Returns a structured result with items, validation outcome, trace, and token usage.

### Try it

Open http://localhost:3000/agent — the test panel lets you type a request and see the agent's trace, validation results, and recommended outfit live.

---

## Environment Variables (all optional)

Copy `.env.example` to `.env` and edit as needed.

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_MATTING_URL` | `http://localhost:8001` | Matting service base URL |
| `MYSTYLIST_MODELS_DIR` | `tools/matting/models` | Model storage directory |
| `MYSTYLIST_UPLOAD_DIR` | `public/uploads` | Matting output directory |
| `HF_ENDPOINT` | (official) | Use `https://hf-mirror.com` in China |
| `AI_PROVIDER` | `mock` | Text model provider: `mock` or `deepseek` |
| `DEEPSEEK_API_KEY` | — | API key when `AI_PROVIDER=deepseek` (server-side only, never `NEXT_PUBLIC_`) |
| `AI_TEXT_MODEL` | `deepseek-chat` | Model name for text generation |
| `AI_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible endpoint |
| `AI_EMBEDDING_PROVIDER` | `local` | Embedding provider: `local` (offline) or `openai` |
| `EMBEDDING_API_KEY` | — | Key when using hosted embeddings (server-side only) |
| `AI_EMBEDDING_MODEL` | — | Embedding model name |
| `AI_EMBEDDING_BASE_URL` | — | Embedding endpoint |
| `MYSTYLIST_METADATA_FILE` | `data/metadata.json` | Metadata storage path |
| `MYSTYLIST_LOG_DIR` | `data/logs` | AI usage log directory |
| `MYSTYLIST_EMBEDDINGS_FILE` | `data/embeddings.json` | Embedding cache path |

---

## Project Structure

```
├── src/
│   ├── app/                              # Next.js App Router pages + API routes
│   │   ├── page.tsx                      # / home
│   │   ├── agent/                        # /agent — AI outfit agent test panel
│   │   ├── stylist/                      # /stylist — wardrobe + sticker board
│   │   ├── wardrobe/                     # /wardrobe/add (upload + matting), /wardrobe/[id]
│   │   ├── profile/                      # /profile, /profile/saved
│   │   ├── outfit/[id]/                  # saved outfit detail
│   │   └── api/                          # API routes
│   │       ├── agent/recommend/          # Agent outfit planner (Phase 6)
│   │       ├── ai/metadata/              # AI clothing metadata extraction (Phase 1)
│   │       ├── ai/classify/              # AI category classification hints
│   │       ├── recommend/                # Deterministic + semantic recommend pipeline (Phase 3-4)
│   │       ├── retrieval/search/         # Semantic wardrobe search (Phase 2)
│   │       ├── retrieval/reindex/        # Rebuild embedding index
│   │       ├── wardrobe/                 # Wardrobe CRUD
│   │       ├── outfits/                  # Outfit CRUD
│   │       └── reset/                    # Reset all data
│   ├── components/                       # UI components (MattingEditor, CutoutImage, Nav, …)
│   │   ├── layout/                       # Nav, layout wrappers
│   │   ├── ui/                           # MattingEditor, CutoutImage, …
│   │   └── looks/                        # Outfit display components
│   ├── i18n/                             # zh.ts / en.ts dictionaries
│   └── lib/
│       ├── agent/                        # ⭐ AI Outfit Agent (Phase 6)
│       │   ├── runner.ts                 # Bounded loop: state → decision → tool → state
│       │   ├── decide.ts                 # Decision layer: mock policy + LLM provider
│       │   ├── tools.ts                  # 6 allowlisted tool handlers
│       │   ├── state.ts                  # State management + query building
│       │   ├── prompt.ts                 # LLM decision prompt
│       │   ├── schema.ts                 # Zod schemas for tool validation
│       │   ├── prefs.ts                  # User preferences provider
│       │   ├── weather.ts                # Weather provider (mock)
│       │   ├── types.ts                  # Full agent type definitions
│       │   └── __tests__/                # Agent unit tests
│       ├── ai/                           # AI provider abstraction (mock + DeepSeek)
│       │   ├── provider.ts               # Provider interface
│       │   └── providers/                # mock.ts, deepseek.ts
│       ├── metadata/                     # Clothing attribute extraction (Phase 1)
│       ├── retrieval/                    # Semantic search + embeddings (Phase 2)
│       ├── recommend/                    # Outfit compose + validation (Phase 3-4)
│       ├── db/                           # JSON file store (store.ts + migrations)
│       ├── services/                     # AI classification service client
│       ├── client/                       # Client-side image helpers
│       ├── telemetry.ts                  # Usage / token accounting
│       └── types.ts                      # Shared data models
├── tools/
│   └── matting/                          # AI matting Python service
│       ├── service.py                    # FastAPI app (GroundingDINO + SAM2)
│       ├── download-models.py            # Model weight downloader
│       ├── requirements.txt              # Python dependencies
│       └── run.bat                       # Windows one-click starter
├── scripts/
│   ├── eval/                             # Evaluation harness + golden sets
│   ├── dev/                              # Dev utilities (seed-dev-wardrobe)
│   ├── fetch-assets.mjs                  # Download demo photo dataset
│   ├── gen-svgs.mjs                      # Generate SVG wardrobe items
│   └── asset-manifest.mjs                # Build asset manifest
├── data/                                 # Runtime data (gitignored)
├── public/uploads/                       # Matting output (gitignored)
└── demo.gif                              # Demo recording
```

### Agent module quick map

| File | Purpose |
|---|---|
| `src/lib/agent/types.ts` | All agent types, tool definitions, state shape |
| `src/lib/agent/runner.ts` | Main loop: iteration budget, timeout, grounding checks |
| `src/lib/agent/decide.ts` | Decision layer — mock policy (offline) + LLM adapter |
| `src/lib/agent/tools.ts` | The 6 allowlisted tool handlers |
| `src/lib/agent/state.ts` | State transitions, constraint merging, query building |
| `src/lib/agent/schema.ts` | Zod validation for every tool's input |
| `src/lib/agent/prompt.ts` | System prompt for LLM decision mode |
| `src/app/api/agent/recommend/route.ts` | HTTP endpoint |
| `src/app/agent/page.tsx` + `AgentPanel.tsx` | Web UI test panel |

---

## Data & Privacy

- All user data (wardrobe, outfits, metadata, embeddings) lives in local `data/`, **excluded via .gitignore**.
- Uploaded photos and cut-out results live in local `public/uploads/`, **also excluded**.
- AI usage logs (token counts, timings) go to `data/logs/`, **excluded**.
- This repo contains no user photos, no runtime data, no model weights, no API keys.
- All API keys are server-side only — never prefixed `NEXT_PUBLIC_`, never shipped to the client bundle.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server |
| `npm run build` | Production build |
| `npm run start` | Run production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript type check |
| `npm test` | Run all unit tests |
| `npm run eval` | Run recommendation evaluation (golden set) |
| `npm run eval:agent` | Run agent evaluation |
| `npm run eval:deepseek` | Run evaluation with DeepSeek provider |

---

## License

MIT
