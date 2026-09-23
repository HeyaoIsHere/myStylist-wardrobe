"""Matting service — GroundingDINO + SAM2 clothing cutout.

Pipeline per request:
  1. GroundingDINO-tiny detects the clothing region (shirt / pants / dress /
     jacket / shoes / …) and returns the best bounding box.
  2. SAM2-tiny turns that box into a precise mask.
  3. The mask strips the background; the garment is cropped to its opaque
     bounds, scaled keeping aspect ratio, centred on a 512×512 transparent
     canvas, and saved as public/uploads/<uuid>.png (served at /uploads/…).

Responses to POST /matting are NDJSON lines so the UI can render live
progress: {"stage":"detect"} → {"stage":"mask"} → {"stage":"normalize"}
→ {"stage":"done","url":…,"categoryHint":…} | {"stage":"error","message":…}

Device tiers (RTX 3050 Laptop 4GB, auto-selected at startup):
  1. both models on CUDA (fp16)
  2. DINO falls back to CPU when VRAM is tight, SAM2 stays on CUDA
  3. everything on CPU (slow but always works)
"""
import base64
import io
import json
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageFilter
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = Path(os.environ.get("MYSTYLIST_MODELS_DIR", ROOT / "tools" / "matting" / "models"))
UPLOAD_DIR = Path(os.environ.get("MYSTYLIST_UPLOAD_DIR", ROOT / "public" / "uploads"))

DINO_DIR = MODELS_DIR / "grounding-dino-tiny"
SAM2_CKPT = MODELS_DIR / "sam2" / "sam2_hiera_tiny.pt"

# Short prompt on purpose: GroundingDINO-tiny's box quality drops with long
# label lists (a 34-phrase prompt measurably worsened boxes in testing).
TEXT_PROMPT = "shirt. pants. skirt. dress. jacket. coat. shoes. bag. hat. socks. scarf."
# Second prompt for the "found nothing" case — small accessories are the
# tiny model's weak spot, so give it the exact words on a retry.
ACCESSORY_PROMPT = (
    "hat. cap. beanie. bandana. scarf. belt. gloves. "
    "necklace. earrings. bracelet. ring. watch. sunglasses. bag. backpack."
)
CANVAS = 512          # output canvas, square
FIT = 460             # garment fits inside this size on the canvas

# DINO label → wardrobe category. Longest matches first so "t-shirt" beats "shirt".
LABEL_TO_CATEGORY = [
    (["t-shirt", "shirt", "blouse", "sweater", "hoodie", "top"], "tops"),
    (["trouser", "pants", "jean", "skirt", "short"], "bottoms"),
    (["dress", "gown"], "dresses"),
    (["jacket", "coat", "blazer", "cardigan", "vest"], "outerwear"),
    (["sneaker", "shoe", "boot", "heel", "sandal"], "shoes"),
    (["handbag", "backpack", "bag", "tote"], "bags"),
    (["necklace", "earring", "bracelet", "ring", "watch", "sunglass", "glasses", "bandana"], "accessories"),
    (["hat", "cap", "beanie", "scarf", "belt", "glove", "tie", "sock"], "others"),
]

# Rough aspect-ratio priors (w/h) per category — dresses hang long, shoes lie
# wide. Masks far outside their category's range get penalised.
CATEGORY_ASPECT = {
    "tops": (0.55, 1.5),
    "bottoms": (0.3, 1.1),
    "dresses": (0.25, 0.9),
    "outerwear": (0.45, 1.3),
    "shoes": (0.8, 2.6),
    "bags": (0.5, 1.6),
    "accessories": (0.3, 2.0),
    "others": (0.3, 2.0),
}


class MattingError(Exception):
    pass


def map_label(label):
    if not isinstance(label, str):
        return "others"  # newer transformers may return token ids
    low = label.lower().lstrip("a ").rstrip(".")
    for needles, category in LABEL_TO_CATEGORY:
        if any(n in low for n in needles):
            return category
    return "others" if low else None


# ————— models, loaded once at startup with graceful device fallback —————
state: dict = {}


def load_models():
    cuda = torch.cuda.is_available()
    # deterministic conv kernels + fixed seeds — the same photo must give the
    # same cutout every run and every STARTUP (fp16/fp32 GPU convs are
    # non-deterministic by default and produced wildly different masks run to
    # run; seeds lock DINO's box ties and SAM2's mask ties too).
    torch.manual_seed(7)
    if cuda:
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False
        torch.cuda.manual_seed_all(7)
    print(f"[matting] CUDA available: {cuda} (deterministic: {bool(torch.backends.cudnn.deterministic)}, seed=7)")

    # 1) GroundingDINO-tiny (transformers runs the official IDEA-Research weights)
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

    state["processor"] = AutoProcessor.from_pretrained(str(DINO_DIR))
    # fp32 on purpose: fp16 CUDA convs are non-deterministic run-to-run,
    # which flips DINO's box choice between near-tied candidates
    try:
        state["dino"] = AutoModelForZeroShotObjectDetection.from_pretrained(str(DINO_DIR))
        state["dino"].to("cuda" if cuda else "cpu").eval()
        state["dino_device"] = "cuda" if cuda else "cpu"
        state["dino_fp16"] = False
    except (RuntimeError, torch.cuda.OutOfMemoryError) as e:  # VRAM too tight → CPU
        print(f"[matting] DINO GPU load failed ({e}) — falling back to CPU")
        state["dino"] = AutoModelForZeroShotObjectDetection.from_pretrained(str(DINO_DIR)).eval()
        state["dino_device"] = "cpu"
        state["dino_fp16"] = False

    # 2) SAM2-tiny (official facebookresearch/sam2 weights via the sam2 package)
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    sam_device = "cuda" if cuda else "cpu"
    try:
        model = build_sam2("configs/sam2/sam2_hiera_t.yaml", checkpoint=str(SAM2_CKPT), device=sam_device, mode="eval")
        # fp16 SAM2 convs are non-deterministic run-to-run (same file as DINO);
        # force fp32 so a given photo yields an identical mask every startup.
        _set_fp16 = getattr(model, "set_use_float16", None)
        if callable(_set_fp16):
            try:
                _set_fp16(False)
            except Exception:
                pass
        state["sam"] = SAM2ImagePredictor(model)
        state["sam_model"] = model  # kept for the automatic mask fallback
        state["sam_device"] = sam_device
    except (RuntimeError, torch.cuda.OutOfMemoryError) as e:
        print(f"[matting] SAM2 GPU load failed ({e}) — falling back to CPU")
        model = build_sam2("configs/sam2/sam2_hiera_t.yaml", checkpoint=str(SAM2_CKPT), device="cpu", mode="eval")
        state["sam"] = SAM2ImagePredictor(model)
        state["sam_model"] = model
        state["sam_device"] = "cpu"

    tier = (
        "gpu"
        if state["dino_device"] == "cuda" and state["sam_device"] == "cuda"
        else "mixed"
        if "cuda" in (state["dino_device"], state["sam_device"])
        else "cpu"
    )
    state["tier"] = tier
    print(f"[matting] models ready — tier: {tier} "
          f"(dino={state['dino_device']}, sam2={state['sam_device']})")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_models()
    yield


app = FastAPI(title="myStylist matting", lifespan=lifespan)

# Local dev origins always allowed; cloud deployments pass their web-app
# origin(s) via MATTING_ALLOW_ORIGINS (comma-separated).
ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"] + [
    o.strip() for o in os.environ.get("MATTING_ALLOW_ORIGINS", "").split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True, "tier": state.get("tier", "loading")}


# Serve the generated overlays from this service too (cloud deployments have
# no Next.js public/ folder to fall back on; locally this is additive).
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")


def line(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


def detect_clothing(img: Image.Image):
    """GroundingDINO → best (box, label). Boxes containing the image centre
    win over higher-scoring edge boxes — garments are usually centred.
    Retry ladder for hard cases: lenient threshold, then an accessory-
    specific prompt, then the centre of the frame."""
    processor = state["processor"]
    fp16 = state.get("dino_fp16", False)

    def run(text: str):
        inputs = processor(images=img, text=text, return_tensors="pt")
        # float tensors follow the model dtype, int64 ids just move devices
        inputs = {
            k: v.to(state["dino_device"], dtype=torch.float16 if fp16 and v.is_floating_point() else v.dtype)
            for k, v in inputs.items()
        }
        with torch.no_grad():
            outputs = state["dino"](**inputs)
        outputs.logits = outputs.logits.float().cpu()
        outputs.pred_boxes = outputs.pred_boxes.float().cpu()
        return outputs, inputs["input_ids"].cpu()

    def post(outputs, input_ids, thr):
        results = processor.post_process_grounded_object_detection(
            outputs,
            input_ids,
            threshold=thr,
            text_threshold=thr,
            target_sizes=[(img.height, img.width)],
        )
        return results[0]

    outputs, input_ids = run(TEXT_PROMPT)
    r = post(outputs, input_ids, 0.25)
    if len(r["boxes"]) == 0:
        r = post(outputs, input_ids, 0.15)
    if len(r["boxes"]) == 0:
        # small accessories are the tiny model's weak spot — retry with the
        # exact words and a loose threshold
        outputs, input_ids = run(ACCESSORY_PROMPT)
        r = post(outputs, input_ids, 0.12)
    if len(r["boxes"]) == 0:
        # DINO can't name the garment — fall back to the centre of the frame:
        # "the important thing in the middle" is still cuttable.
        w, h = img.width, img.height
        return [w * 0.2, h * 0.2, w * 0.8, h * 0.8], None, None
    w, h = img.width, img.height
    centred = [
        i for i, b in enumerate(r["boxes"])
        if b[0] <= w / 2 <= b[2] and b[1] <= h / 2 <= b[3]
    ]
    pool = centred or list(range(len(r["boxes"])))
    best = int(max(pool, key=lambda j: float(r["scores"][j])))
    label = r["labels"][best]
    return r["boxes"][best].tolist(), label, map_label(label)


def clean_mask(mask: np.ndarray) -> np.ndarray:
    """Fill small holes, keep the garment's connected regions — up to 3
    components at least 15% the size of the largest. Shoes come in pairs:
    dropping everything but the single biggest component amputates the
    second shoe. Noise-sized bits still get discarded."""
    m = ndimage.binary_fill_holes(mask)
    labeled, n = ndimage.label(m)
    if n == 0:
        return None
    sizes = ndimage.sum(m, labeled, range(1, n + 1))
    order = np.argsort(sizes)[::-1]
    keep = [int(order[0])]
    for idx in order[1:]:
        if sizes[idx] < 0.15 * sizes[order[0]]:
            break
        keep.append(int(idx))
        if len(keep) >= 3:
            break
    out = np.zeros_like(m)
    for i in keep:
        out |= labeled == (i + 1)
    return out


def pick_garment_mask(masks, scores, w, h, box, category, bg_fam=None):
    """Choose the mask that is the WHOLE garment, not a fragment of it.

    SAM2's three candidates are usually whole / part / sub-part — the
    highest model score is often the sub-part. Completeness (how much of
    the detected box the mask covers) therefore outweighs the raw score,
    and the detected category adds an aspect-ratio prior (dresses hang
    long, shoes lie wide).

    On floor photos SAM2 also offers "slab" masks — floor + shadow lobes,
    sometimes with the garment as a hole. A mask is penalised by the
    fraction of its pixels that belong to the background's colour family
    (`bg_fam`, precomputed by border_family_mask), so a floor slab loses to
    a genuine garment mask. A SMALL candidate that fails the box-cover
    floor may still compete when it is background-free (the "small dress on
    a large frame" case) — guarded by size and border-touch bounds."""
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    x1, y1, x2, y2 = box
    box_area = max(1.0, (x2 - x1) * (y2 - y1))

    best_mask, best_score, best_cover, best_idx = None, -1e9, 0.0, -1
    for idx_cand, (m, s) in enumerate(zip(masks, scores)):
        cm = clean_mask(m)
        if cm is None:
            continue
        frac = float(cm.mean())
        # jewellery / small shoes can be well under 1% of the frame —
        # small-category floors are lower
        small = category in ("accessories", "others", "shoes")
        frac_lo = 0.003 if small else 0.02
        if not (frac_lo <= frac <= 0.90):
            continue  # noise-sized or background-sized — not a garment
        ys, xs = np.nonzero(cm)
        inside = (xs >= x1) & (xs <= x2) & (ys >= y1) & (ys <= y2)
        cover = float(inside.sum()) / box_area
        cover_lo = 0.05 if small else 0.15
        touches = 0
        if xs.min() == 0:
            touches += 1
        if xs.max() == w - 1:
            touches += 1
        if ys.min() == 0:
            touches += 1
        if ys.max() == h - 1:
            touches += 1
        floorish = float(bg_fam[cm].mean()) if bg_fam is not None else 0.0
        # WHITEWASH mode: ≥92% of the frame is the background's own colour
        # family (white shoes on white paper, ivory on ivory…). Colour
        # evidence is then untrustworthy — the garment IS the background
        # colour — so purity gates fall back to geometry-only and the slab
        # tax is hardly charged.
        whitewash = bg_fam is not None and float(bg_fam.mean()) > 0.92
        purity_ok = floorish < 0.08 or whitewash
        # a small dress on a large frame fails cover_lo even though it IS the
        # garment — admit it when it is a compact, background-free object
        # (this is how floor slabs with a garment-shaped hole lose the pick)
        small_distinct = cover < cover_lo and touches <= 1 and frac >= (0.004 if small else 0.01) and purity_ok
        if cover < cover_lo and not small_distinct:
            continue  # a sub-part fragment — the sleeves-only mask
        score = float(s) + 2.0 * min(1.0, cover) + 0.8 * frac
        score -= touches * 0.5
        slab_tax = 0.5 if whitewash else 5.0
        score -= slab_tax * floorish  # floor slab tax (colour-family evidence)
        if not cm[int(cy), int(cx)]:
            score -= 1.0  # prefer masks covering the box centre (soft — small
                          # accessories may sit above or below it)
        if category in CATEGORY_ASPECT:
            aspect = (xs.max() - xs.min() + 1) / (ys.max() - ys.min() + 1)
            lo, hi = CATEGORY_ASPECT[category]
            if lo <= aspect <= hi:
                score += 0.5
        if score > best_score:
            best_score, best_mask, best_cover, best_idx = score, cm, cover, idx_cand

    if best_mask is None:
        raise MattingError("no clean garment mask")
    # geometric-only background rejects live in cut_out (colour sanity check);
    # a large centred garment can legitimately touch every border.
    return best_mask, best_cover, best_idx


def feather_mask(bin_mask, sigma: float = 1.0):
    """Turn a hard binary silhouette into a soft 0..1 alpha.

    Anti-aliasing for the cutout: the old overlay used SAM2's binarized mask,
    whose edges are pixel-perfect 0/255 — they come out as a staircase when
    scaled. A small isotropic gaussian turns the silhouette boundary into a
    1–2 px partial-alpha ramp (deterministic, aspect-correct, cheap). The
    faint outward halo IS the anti-aliasing — it makes diagonal/curved edges
    smooth instead of furry."""
    if bin_mask.dtype != np.float32:
        bin_mask = bin_mask.astype(np.float32)
    return np.clip(ndimage.gaussian_filter(bin_mask, sigma=sigma), 0.0, 1.0)


def merge_shoe_pair(keep, masks, w, h):
    """Shoes come in twos — SAM2-tiny often yields ONE full shoe per
    candidate, with the mate living in a suppressed candidate. Union every
    size-comparable, non-overlapping companion component from the OTHER
    candidates into the winner. Geometry-only and bounded: a background slab
    many times the shoe's size is never a sibling."""
    out = keep.copy()
    lab, n = ndimage.label(keep)
    if n == 0:
        return out
    sizes = ndimage.sum(keep, lab, range(1, n + 1))
    largest = float(sizes.max())
    merged = 0
    for m in masks:
        cm = clean_mask(m)  # noise specks measured against the CANDIDATE, not
        if cm is None:      # against the winner — debris never passes
            continue
        c_lab, cn = ndimage.label(cm)
        if cn == 0:
            continue
        c_sizes = ndimage.sum(cm, c_lab, range(1, cn + 1))
        for i in range(1, cn + 1):
            comp = c_lab == i
            sz = float(c_sizes[i - 1])
            if not (0.25 * largest <= sz <= 3.0 * largest):
                continue
            if float((comp & keep).sum()) > 0.30 * sz:
                continue
            out |= comp
            merged += 1
            if merged >= 3:
                return out
    if merged:
        print(f"[cutout] shoe pair: merged {merged} companion component(s)")
    return out


def logits_alpha(logits_winner, keep, h, w):
    """Soft alpha from the winner's RAW 256×256 logits, not its binarized
    counterpart. The binary mask's contour follows 4-px blocks (256→full-res
    nearest-ish picks) — that blockiness IS the user-visible sawtooth.
    Sigmoid → bilinear upsample to the photo resolution (the same rectangular
    mapping SAM2 itself uses, so aspect stays true) gives a genuinely smooth
    sub-pixel contour; the keep mask's 3px dilation caps how far the soft edge
    may roam, and pixels inside the keep silhouette are floored at 0.85 so
    fold shadows can't go translucent. A final 1px feather melts the floor
    seam."""
    t = torch.as_tensor(logits_winner, dtype=torch.float32)[None, None]
    prob = torch.sigmoid(
        torch.nn.functional.interpolate(t, size=(h, w), mode="bilinear", align_corners=False)
    )[0, 0].cpu().numpy()
    cap = ndimage.binary_dilation(keep, iterations=3).astype(np.float32)
    alpha = prob * cap
    alpha = np.where(keep, np.maximum(alpha, 0.85), alpha)
    alpha = np.clip(alpha, 0.0, 1.0)
    alpha = feather_mask(alpha, sigma=0.8)
    # a feather can push 1-3px-wide strips (scarf ribbons, shoe straps) under
    # the visibility threshold — re-floor the silhouette so thin parts survive
    return np.clip(np.maximum(alpha, keep.astype(np.float32) * 0.80), 0.0, 1.0)


def prompt_points(box, w, h):
    """Foreground points inside the box (centre + ring) and background points
    at the frame corners/edges outside the box. Positive+negative prompts
    anchor SAM2: garment in the middle, background at the borders."""
    x1, y1, x2, y2 = box
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    bw, bh = x2 - x1, y2 - y1
    pos = [
        (cx, cy),
        (cx - bw * 0.3, cy), (cx + bw * 0.3, cy),
        (cx, cy - bh * 0.3), (cx, cy + bh * 0.3),
    ]
    pos = [(x, y) for x, y in pos if 0 <= x < w and 0 <= y < h]
    neg = []
    for x, y in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
                 (w / 2, 0), (w / 2, h - 1), (0, h / 2), (w - 1, h / 2)]:
        if not (x1 <= x <= x2 and y1 <= y <= y2):
            neg.append((x, y))
    return pos, neg


def touches_all_borders(mask, w, h) -> bool:
    ys, xs = np.nonzero(mask)
    return len(xs) > 0 and xs.min() == 0 and xs.max() == w - 1 and ys.min() == 0 and ys.max() == h - 1


def mask_looks_like_background(img_arr, mask) -> bool:
    """Colour sanity check: a mask whose average colour matches the frame
    border (where backgrounds live) is not a garment."""
    px = img_arr[mask]
    if len(px) == 0:
        return True
    b = max(4, int(0.05 * min(img_arr.shape[:2])))
    border = np.concatenate([
        img_arr[:b].reshape(-1, 3), img_arr[-b:].reshape(-1, 3),
        img_arr[:, :b].reshape(-1, 3), img_arr[:, -b:].reshape(-1, 3),
    ])
    return float(np.abs(px.mean(0) - border.mean(0)).max()) < 12


def complete_mask_with_key(mask, img_arr, box, category):
    """Recover REGIONS SAM2 left out, using chroma-key evidence inside the box.

    Called ONLY from cut_out when the SAM2 mask already covers less than 35%
    of the DINO box (a shrunken mask) — in the healthy case this function is
    never reached, because its old unconditional run was the main source of the
    "green blob covering background" bug (it unioned every non-background-
    coloured block inside the box — hangers, walls, shadows — into the garment).

    Merge is deliberately strict:
      · chroma-key threshold raised 25 → 35 so subtle background shifts can't key;
      · a component merges only if > 50% of its pixels already overlap the mask
        (it must extend FROM the silhouette, never float in mid-background).
    For shoes a detached keyed component of comparable size is still kept as
    the second shoe of the pair (SAM2 crops one shoe per mask by design)."""
    keyed = border_key_mask(img_arr, box, t=35)
    if keyed is None:
        return mask
    labeled, n = ndimage.label(keyed)
    if n == 0:
        return mask
    if n > 8:
        return mask  # noisy background texture — not safe to merge from
    sizes = ndimage.sum(labeled > 0, labeled, range(1, n + 1))
    mask_labeled, mn = ndimage.label(mask)
    mask_sizes = ndimage.sum(mask > 0, mask_labeled, range(1, mn + 1)) if mn else np.array([])
    largest = float(mask_sizes.max()) if len(mask_sizes) else 0.0
    out = mask.copy()
    for i in range(1, n + 1):
        comp = labeled == i
        inter = float(np.logical_and(comp, mask).sum())
        ratio = inter / max(float(comp.sum()), 1.0)
        sibling = (
            category == "shoes"
            and largest > 0
            and inter == 0
            and 0.25 * largest <= float(comp.sum()) <= 1.75 * largest
        )
        if ratio > 0.5 or sibling:
            out |= comp
    # re-clean the union: fill holes, keep sizeable components, drop specks
    out = ndimage.binary_fill_holes(out)
    labeled2, n2 = ndimage.label(out)
    if n2 == 0:
        return mask
    sizes2 = ndimage.sum(out, labeled2, range(1, n2 + 1))
    order = np.argsort(sizes2)[::-1]
    keep = [int(order[0])]
    for idx in order[1:]:
        if sizes2[idx] < 0.10 * sizes2[keep[0]]:
            break
        keep.append(int(idx))
        if len(keep) >= 3:
            break
    out2 = np.zeros_like(out)
    for i in keep:
        out2 |= labeled2 == (i + 1)
    return out2


def border_family_mask(img_arr, raw_thr=28, angle_thr=0.985, lum_thr=0.95):
    """Pixels that are the BACKGROUND's own family: the frame-border median
    colour within a small raw distance, OR the same hue ray but darker (floor/
    haze in shadow — flat-lay photos on floors, not e-commerce white).

    Two full-frame float32 passes, cheap next to SAM2. The hue-ray test is
    DRAGON-FREE except for the darker-than-border clause: a garment parked on
    the floor is usually lit BRIGHTER than the shadowed floor around it, so it
    is not swallowed by `lum_thr`."""
    h, w = img_arr.shape[:2]
    b = max(4, int(0.05 * min(h, w)))
    border = np.concatenate([
        img_arr[:b].reshape(-1, 3), img_arr[-b:].reshape(-1, 3),
        img_arr[:, :b].reshape(-1, 3), img_arr[:, -b:].reshape(-1, 3),
    ]).astype(np.float32)
    med = np.median(border, axis=0)
    v = img_arr.astype(np.float32)
    raw_dist = np.sqrt(((v - med) ** 2).sum(-1)) / np.sqrt(3)
    m = np.linalg.norm(v, axis=-1)
    mm = float(np.linalg.norm(med))
    cosang = np.einsum("ijk,k->ij", v, med) / np.maximum(m * mm, 1e-3)
    lumr = m / mm
    fam = (raw_dist < raw_thr) | ((cosang > angle_thr) & (lumr < lum_thr))
    return fam, float(fam.mean()), med


def refine_mask(mask, img_arr, box, bg_fam=None):
    """Strip background-family pixels out of the picked mask and re-close it.

    On a uniform background SAM2's mask routinely swallows background
    envelope pixels — white e-commerce rects, floor slabs fused with shadow.
    The garment body = mask pixels that are NOT bg-family; a closing (16px
    disc, coarse) reconnects parts a white gap or a fold separated; the cap
    (6px dilation of the original mask) stops the fill from ever growing
    past the chosen mask's own envelope. If the body is < 20% of the mask,
    the garment may BE the background colour (white-on-white): subtracting
    would eviscerate it — hand the mask back untouched (that case is
    handled by the contrast-retry lane instead)."""
    if bg_fam is None:
        return mask
    body = mask & ~bg_fam
    total = float(mask.sum())
    if total < 1.0 or body.sum() < 0.20 * total:
        return mask
    h, w = mask.shape
    small = ndimage.zoom(mask.astype(np.float32), 0.25, order=0) > 0.5
    ym, xm = np.mgrid[-4:5, -4:5]
    disk16 = (ym.astype(float) ** 2 + xm.astype(float) ** 2) <= 16.0
    body_s = ndimage.zoom(body.astype(np.float32), 0.25, order=0) > 0.5
    closed_s = ndimage.binary_closing(body_s, structure=disk16)
    big_s = closed_s & small  # never leave the coarse envelope of the mask
    try:
        big = ndimage.zoom(
            big_s.astype(np.float32),
            (mask.shape[0] / big_s.shape[0], mask.shape[1] / big_s.shape[1]),
            order=0,
        ) > 0.5
    except ValueError:
        return mask
    cap = ndimage.binary_dilation(mask, iterations=6)
    out = big & cap
    # drop components that never overlapped the body (cap remnants)
    labeled, n = ndimage.label(out)
    if n == 0:
        return mask
    keep_comp = np.zeros(n, dtype=bool)
    for i in range(1, n + 1):
        if (body & (labeled == i)).any():
            keep_comp[i - 1] = True
    if keep_comp.sum() == 0:
        return mask
    out = np.isin(labeled, np.nonzero(keep_comp)[0] + 1).reshape(h, w)
    return out


def border_key_mask(img_arr, box, t=40):
    """Classical chroma keying fallback: estimate the frame-border colour and
    keep everything inside the box whose colour differs from it. Flat-lay
    photos on plain backgrounds get a COMPLETE silhouette this way — the one
    thing SAM2's masks often lack. Rejects itself when the border colour
    spread says the background is busy."""
    h, w, _ = img_arr.shape
    step = max(1, min(w, h) // 120)
    samples = []
    for x in range(0, w, step):
        samples.append(img_arr[0, x].astype(np.float32))
        samples.append(img_arr[h - 1, x].astype(np.float32))
    for y in range(0, h, step):
        samples.append(img_arr[y, 0].astype(np.float32))
        samples.append(img_arr[y, w - 1].astype(np.float32))
    s = np.array(samples, dtype=np.float32)
    bg = np.median(s, axis=0)
    spread = float(np.abs(s - bg).mean())
    if spread > 48:
        return None  # busy scene — classical keying would guess wrong
    dist = np.sqrt(((img_arr.astype(np.float32) - bg) ** 2).sum(-1)) / np.sqrt(3)
    m = np.zeros((h, w), dtype=bool)
    x1, y1, x2, y2 = box
    x0, y0 = max(0, int(x1)), max(0, int(y1))
    xx, yy = min(w, int(x2)), min(h, int(y2))
    m[y0:yy, x0:xx] = dist[y0:yy, x0:xx] > t
    m = ndimage.binary_fill_holes(m)
    labeled, n = ndimage.label(m)
    if n == 0:
        return None
    sizes = ndimage.sum(m, labeled, range(1, n + 1))
    m = labeled == (int(np.argmax(sizes)) + 1)
    frac = float(m.mean())
    if not (0.005 <= frac <= 0.9):
        return None
    return m


def complete_garment_folds(mask, img_arr, box, bg_fam=None):
    """Fill the wrinkle shadows/highlights SAM2 carved OUT of the garment.

    Flat-lay photos are contrasty: fold shadows read as separate dark
    objects, so SAM2's mask runs AROUND them and the cutout shows the floor
    through the clothing. A morphological CLOSING with a ~12px disc fills
    only CONCAVE pockets (wrinkle bays): the outer silhouette and thin parts
    (straps, string ties) survive a disc closing exactly, so the old
    sawtooth/square bloat does not come back. The fill is then gated to
    pixels on the garment's own hue ray (lighter OR darker, same chroma):
    a floor wedge between trouser legs (different hue) is never absorbed,
    and distance-blended edge pixels outside the silhouette are not even
    candidates. fill_holes afterwards repairs fully enclosed creases. The
    closing runs on a 4x-downscaled mask (disc radius 3 there == 12 here)
    so it stays cheaper than one SAM2 forward."""
    h, w = img_arr.shape[:2]
    core = ndimage.binary_erosion(mask, iterations=2)
    if not core.any():
        return mask
    whitewash = bg_fam is not None and float(bg_fam.mean()) > 0.92
    sel = core & ~bg_fam if bg_fam is not None else core
    if sel.sum() < 300:  # not enough pure-garment evidence (e.g. white shirt
        if not whitewash:
            return ndimage.binary_fill_holes(mask)  # on white bg — SAM2 is whole
        sel = core  # white garment on white paper: the garment IS the
        if sel.sum() < 300:  # background colour — model from the raw core
            return ndimage.binary_fill_holes(mask)
    mask = ndimage.binary_fill_holes(mask)  # enclosed creases first: the
    # closing below may BRIDGE pockets, but only the bridge pixels pass the
    # hue gate — a bridged floor wedge must not be blanket-filled afterwards
    med = np.median(img_arr[sel].astype(np.float32), axis=0)
    mm = float(np.linalg.norm(med))
    if mm < 1e-3:
        return mask
    v = img_arr.astype(np.float32)
    m = np.linalg.norm(v, axis=-1)
    cosang = np.einsum("ijk,k->ij", v, med) / np.maximum(m * mm, 1e-3)
    # blown specular highlights (shiny leather, satin sheen) are desaturated
    # near-white — off the garment's hue ray, so the ray gate alone would
    # leave them un-matted. They live ON the garment: absorb them wherever
    # they sit inside a closing pocket.
    sat = (v.max(-1) - v.min(-1)) / np.maximum(v.max(-1), 1.0)
    highlight = (sat < 0.08) & (m > 1.10 * mm)
    # 0.994, not lower: distance-blended pixels between a warm garment and a
    # warm floor sit at ~0.988-0.993 and must NOT be absorbed — fold shadows
    # sit within noise of 1.0
    r_coarse = 3  # == 12 px at full resolution
    yy, xx = np.mgrid[-r_coarse:r_coarse + 1, -r_coarse:r_coarse + 1]
    disk = (yy.astype(float) ** 2 + xx.astype(float) ** 2) <= r_coarse * r_coarse
    small = ndimage.zoom(mask.astype(np.float32), 0.25, order=0) > 0.5
    closed_s = ndimage.binary_closing(small, structure=disk)
    # zoom back with exact per-axis factors: round(0.25x) can leave the coarse
    # grid one row larger than 4x of the original
    closed = ndimage.zoom(
        closed_s.astype(np.float32),
        (mask.shape[0] / closed_s.shape[0], mask.shape[1] / closed_s.shape[1]),
        order=0,
    ) > 0.5
    x1, y1, x2, y2 = box
    yg, xg = np.mgrid[0:h, 0:w]
    pad = 12
    in_box = (xg >= x1 - pad) & (xg <= x2 + pad) & (yg >= y1 - pad) & (yg <= y2 + pad)
    if whitewash:
        # on white paper the garment's grey interior shadows (darker than the
        # paper, low saturation) are the ONLY fold evidence left — absorb them
        # inside closing pockets; brighter-than-paper pockets stay open
        absorb = (cosang > 0.994) | highlight | ((m < 1.02 * mm) & (sat < 0.25))
    else:
        absorb = (cosang > 0.994) | highlight
    add = closed & ~mask & in_box & absorb
    if add.any():
        mask = mask | add
    # the closing may BRIDGE an open bay shut — the pocket interior is now
    # enclosed but still empty. Fill it ONLY with absorb-coloured pixels
    # (garment shadows/highlights): a bridged floor wedge between trouser
    # legs stays open, a fold pocket fills. This was the missing half of
    # the fold repair (93k px of bridged-pocket leftovers on white pieces).
    enclosed = ndimage.binary_fill_holes(mask) & ~mask
    if enclosed.any():
        mask = mask | (enclosed & absorb)
    # narrow-mouth bays: the SOFT alpha stage later seals them with its 3px
    # cap and they show up as unfilled pockets; mirror that seal here and
    # fill the garment-coloured interior while the binary mask still exists
    # (~98% of these pockets measured garment-coloured on the white pieces).
    inflated = ndimage.binary_dilation(mask, iterations=3)
    bays = ndimage.binary_fill_holes(inflated) & ~mask & absorb
    if bays.any():
        mask = mask | bays
    return mask


def enhance_contrast(img_arr):
    """Retry-lane input for low-contrast photos (white garment on white bg):
    unsharp masking on luminance. The silhouette edges — invisible to
    SAM2/DINO on the raw frame, where the garment and the paper are the same
    colour — become pronounced. Geometry is untouched, so masks map back 1:1
    onto the original photo."""
    f = img_arr.astype(np.float32)
    lum = f.mean(-1)
    low = ndimage.gaussian_filter(lum, sigma=12.0)
    detail = lum - low
    return np.clip(f + detail[..., None] * 2.2, 0, 255).astype(np.uint8)


def cut_out(img: Image.Image, box, category):
    """SAM2 → soft (anti-aliased) alpha mask, at ORIGINAL photo resolution.

    Chain: (1) box + positive/negative point prompts, garment-shaped mask
    selection; (2) the winner's raw SIGMOID logits bilinearly upsampled — the
    soft edge kills the old sawtooth; (3) the cleaned binary silhouette is
    used ONLY as a keep-region (drop stray specks / detached background lobes),
    it never expands the alpha — so no more green block around the garment;
    (4) floor slabs are priced out at pick time (border colour family);
    (5) background-family pixels are stripped from the winner and the body
    re-closed (refine_mask — kills white-bg rects and fused floor shadows);
    (6) wrinkle shadows/highlights inside the silhouette are reabsorbed;
    (7) chroma-key completion, strictly gated to the shrunken-mask case;
    (8) LOW-CONTRAST LANE — when the primary lane failed or its mask is
    nearly all background-coloured (white garment on white paper), retry
    the whole chain on an unsharp-masked copy whose edges SAM2/DINO can see.
    Returns a float 0..1 alpha (the browser applies it directly; the final 512
    cutout happens client-side)."""
    w, h = img.width, img.height
    img_arr = np.asarray(img.convert("RGB"), dtype=np.uint8)
    predictor = state["sam"]
    # albino: > 60% of the picked silhouette is the background's own colour —
    # the typical signature of a white garment on a white background (or a
    # slab that swallowed the paper). The colour test against the family runs
    # on the SAME array the mask was picked from (per-lane).
    ALBINO = 0.60

    def attempt(arr, box, category, tag):
        fam, frame_fam_frac, _med = border_family_mask(arr)
        predictor.set_image(arr)
        pos, neg = prompt_points(box, w, h)
        masks, scores, logits = predictor.predict(
            point_coords=np.array(pos + neg, dtype=np.float32),
            point_labels=np.array([1] * len(pos) + [0] * len(neg), dtype=np.int32),
            box=np.array([box], dtype=np.float32),
            multimask_output=True,
        )
        try:
            keep, cover, idx = pick_garment_mask(masks, scores, w, h, box, category, bg_fam=fam)
            print(f"[cutout{tag}] prompt pick frac={keep.mean():.3f} cover={cover:.3f} "
                  f"floorish={float(fam[keep].mean()):.3f} frame_fam={frame_fam_frac:.3f} "
                  f"touches_all={touches_all_borders(keep, w, h)} "
                  f"looks_bg={mask_looks_like_background(arr, keep)}")
            if touches_all_borders(keep, w, h) and mask_looks_like_background(arr, keep):
                raise MattingError("looks like background")
            # shrunken-mask rescue ONLY: when SAM2 covered < 35% of the
            # detected box it probably missed a big chunk (e.g. only the
            # collar of a coat), so let chroma-key extend it. Healthy masks
            # skip this entirely — the old unconditional run was the main
            # source of "green blob over the background" (it unioned every
            # non-background block in the box). A small garment in a large
            # box also fails cover<0.35: rescue then keyed the FLOOR, not the
            # garment. Gate the rescue on the keyed candidate itself — if it
            # is mostly background-family, the keying evidence is floor and
            # must be dropped (the small pick is correct).
            if cover < 0.35:
                keyed = border_key_mask(arr, box)
                key_floorish = float(fam[keyed].mean()) if keyed is not None else 0.0
                if keyed is None or key_floorish < 0.30:
                    try:
                        keep = complete_mask_with_key(keep, arr, box, category)
                    except Exception:
                        print("[cutout] mask completion failed — keeping SAM2 mask")
            if category == "shoes":
                keep = merge_shoe_pair(keep, masks, w, h)
            keep = refine_mask(keep, arr, box, fam)
            keep = complete_garment_folds(keep, arr, box, fam)
            # SOFT alpha from the winner's own logits — the binarized mask's
            # 4px-block contours ARE the user-visible sawtooth
            alpha = logits_alpha(logits[idx], keep, h, w)
            return alpha, (fam[keep].mean() > ALBINO)
        except MattingError:
            pass  # fall through to the border-key rescue inside this lane
        key = border_key_mask(arr, box)
        if key is None or mask_looks_like_background(arr, key):
            raise MattingError("no clean garment mask")
        key = refine_mask(key, arr, box, fam)
        print(f"[cutout{tag}] border-key fallback frac={key.mean():.3f} "
              f"touches_all={touches_all_borders(key, w, h)} "
              f"looks_bg={mask_looks_like_background(arr, key)}")
        # feather the fallback slightly so even the rescue path isn't sawtooth
        return feather_mask(key, sigma=1.2), (fam[key].mean() > ALBINO)

    try:
        alpha, albino = attempt(img_arr, box, category, "")
    except MattingError:
        # primary lane dead (pick and keying both failed) — one retry on the
        # enhanced copy before giving up to the manual brush
        print("[cutout] primary lane failed — low-contrast lane")
        enh = enhance_contrast(img_arr)
        box2, _label2, cat2 = detect_clothing(Image.fromarray(enh))
        alpha, _albino2 = attempt(enh, box2, cat2, " L2")
        return np.asarray(alpha, dtype=np.float32)

    # the retry lane helps only where a large garment fuses with the paper
    # (tops/dresses/outerwear/bottoms). Compact pieces — shoes, bags, jewellery,
    # hats — don't slab-fuse; their raw-lane mask is already the whole object
    # and the enhanced retry has been observed to return it INCOMPLETE.
    LARGE_GARMENT_CATS = ("tops", "dresses", "outerwear", "bottoms")

    if albino and category in LARGE_GARMENT_CATS:
        print("[cutout] albino mask — low-contrast lane (white garment on white bg?)")
        try:
            enh = enhance_contrast(img_arr)
            box2, _label2, cat2 = detect_clothing(Image.fromarray(enh))
            alpha2, _albino2 = attempt(enh, box2, cat2, " L2")
            # the enhanced image has only EDGES to segment — a retry can pick
            # a junk trunk far smaller than the primary mask. Cheap sanity:
            # never replace the primary with something 3x smaller.
            if (alpha2 > 0.5).sum() < 0.30 * max(int((alpha > 0.5).sum()), 1):
                print("[cutout] L2 mask too small vs primary — keeping primary")
            else:
                alpha = alpha2
        except MattingError as e:
            print(f"[cutout] low-contrast lane failed too ({e}) — keeping primary mask")
    elif albino:
        print("[cutout] albino mask on a compact piece — keeping primary (raw lane "
              "already segments the whole object)")

    return np.asarray(alpha, dtype=np.float32)


def normalize_cutout(out: Image.Image, source: Image.Image | None = None) -> Image.Image:
    """Crop the transparent margins (small padding kept), fit inside the
    512 canvas keeping aspect ratio, centre. When `source` (the original
    photo) is given, its RGB is kept UNDER the transparent pixels — normal
    compositing ignores it, but the manual brush can restore real photo
    pixels where the auto mask was wrong."""
    arr = np.asarray(out)[..., 3]
    ys, xs = np.nonzero(arr > 10)
    if len(xs) == 0:
        raise MattingError("empty cutout")
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    pad = max(8, round(0.03 * max(x1 - x0, y1 - y0)))
    crop_box = (
        max(0, x0 - pad), max(0, y0 - pad),
        min(out.width, x1 + pad), min(out.height, y1 + pad),
    )
    crop = out.crop(crop_box)
    scale = min(1.0, FIT / max(crop.width, crop.height))
    size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
    px, py = (CANVAS - size[0]) // 2, (CANVAS - size[1]) // 2
    resized = crop.resize(size, Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    if source is not None:
        # fallback layer: the whole photo scaled to FILL the canvas
        # (cover-fit), so the brush has plausible pixels everywhere
        w0, h0 = source.size
        scale_cover = max(CANVAS / w0, CANVAS / h0)
        nw, nh = round(w0 * scale_cover), round(h0 * scale_cover)
        cover = source.convert("RGB").resize((nw, nh), Image.LANCZOS)
        bg = cover.crop(((nw - CANVAS) // 2, (nh - CANVAS) // 2,
                         (nw - CANVAS) // 2 + CANVAS, (nh - CANVAS) // 2 + CANVAS))
        # aligned layer on top with feathered edges: exact photo pixels
        # under the garment region, no visible seam against the cover-fit
        rgb = source.convert("RGB").crop(crop_box).resize(size, Image.LANCZOS)
        yy, xx = np.mgrid[0:size[1], 0:size[0]]
        edge = np.minimum(np.minimum(xx, size[0] - 1 - xx), np.minimum(yy, size[1] - 1 - yy))
        patch_a = Image.fromarray((np.clip(edge.astype(np.float32) / 6.0, 0, 1) * 255).astype(np.uint8))
        patch = rgb.convert("RGBA")
        patch.putalpha(patch_a)
        bg.paste(patch, (px, py), patch)
        canvas.paste(bg.convert("RGBA"), (0, 0))
        alpha_full = Image.new("L", (CANVAS, CANVAS), 0)
        alpha_full.paste(resized.getchannel("A"), (px, py))
        canvas.putalpha(alpha_full)
    else:
        canvas.paste(resized, (px, py), resized)
    return canvas


def photo_canvas(img: Image.Image) -> Image.Image:
    """Cover-fit the photo into the 512 canvas (opaque RGB) — the base the
    manual brush paints on when the auto pipeline found nothing."""
    w0, h0 = img.size
    scale = max(CANVAS / w0, CANVAS / h0)
    nw, nh = round(w0 * scale), round(h0 * scale)
    cover = img.convert("RGB").resize((nw, nh), Image.LANCZOS)
    return cover.crop(((nw - CANVAS) // 2, (nh - CANVAS) // 2,
                       (nw - CANVAS) // 2 + CANVAS, (nh - CANVAS) // 2 + CANVAS))


@app.post("/matting")
async def matting(request: Request, body: dict):
    image_b64 = (body or {}).get("image", "")
    if not image_b64:
        return StreamingResponse(iter([line({"stage": "error", "message": "no image"})]),
                                 media_type="application/x-ndjson", status_code=400)

    def gen():
        try:
            yield line({"stage": "detect"})
            raw = base64.b64decode(image_b64.split(",", 1)[-1])
            img = Image.open(io.BytesIO(raw)).convert("RGB")

            box, label, category = detect_clothing(img)
            print(f"[cutout] box={[round(v) for v in box]} label={label} cat={category} img={img.size}")
            yield line({"stage": "mask"})
            try:
                mask = cut_out(img, box, category)
            except MattingError as e:
                # manual fallback: empty mask at original size — the user
                # paints the keep region on the original photo themselves
                print(f"[cutout] local pipeline failed ({e}) — manual fallback")
                mask = np.zeros((img.height, img.width), dtype=np.float32)
                stage_out = "manual"
            else:
                stage_out = "done"
            yield line({"stage": "normalize"})

            # green overlay PNG at ORIGINAL resolution: RGB = green tint,
            # alpha = soft keep mask (0..255 — anti-aliased garment edges).
            # The browser draws it straight onto the original photo; the final
            # 512 cutout happens client-side.
            UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            fname = f"{uuid.uuid4().hex}.png"
            overlay = np.zeros((img.height, img.width, 4), dtype=np.uint8)
            overlay[..., 0] = 46
            overlay[..., 1] = 204
            overlay[..., 2] = 113
            overlay[..., 3] = np.clip(mask * 255.0, 0, 255).astype(np.uint8)
            Image.fromarray(overlay).save(UPLOAD_DIR / fname)
            if state.get("sam_device") == "cuda":
                torch.cuda.empty_cache()
            yield line({
                "stage": stage_out,
                "url": f"/uploads/{fname}",
                # absolute base so the browser can load the overlay from
                # this service even when the web app lives on another origin
                "baseUrl": str(request.base_url).rstrip("/"),
                "categoryHint": category,
            })
        except MattingError as e:
            yield line({"stage": "error", "message": str(e)})
        except Exception as e:  # keep the stream alive and tell the client
            import traceback

            print(f"[matting] pipeline error: {e!r}")
            traceback.print_exc()
            try:
                raw = base64.b64decode(image_b64.split(",", 1)[-1])
                Image.open(io.BytesIO(raw)).convert("RGB").save(
                    ROOT / "tools" / "matting" / "debug-fail.jpg"
                )
                print("[matting] failing image saved to tools/matting/debug-fail.jpg")
            except Exception:
                pass
            yield line({"stage": "error", "message": "pipeline failed"})

    return StreamingResponse(gen(), media_type="application/x-ndjson")
