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
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
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
    if cuda:
        # deterministic conv kernels — the same photo must give the same
        # cutout every run (fp16/fp32 GPU convs are non-deterministic by
        # default and produced wildly different masks run to run)
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False
    print(f"[matting] CUDA available: {cuda}")

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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True, "tier": state.get("tier", "loading")}


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


def pick_garment_mask(masks, scores, w, h, box, category):
    """Choose the mask that is the WHOLE garment, not a fragment of it.

    SAM2's three candidates are usually whole / part / sub-part — the
    highest model score is often the sub-part. Completeness (how much of
    the detected box the mask covers) therefore outweighs the raw score,
    and the detected category adds an aspect-ratio prior (dresses hang
    long, shoes lie wide).
    """
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    x1, y1, x2, y2 = box
    box_area = max(1.0, (x2 - x1) * (y2 - y1))

    best_mask, best_score, best_cover = None, -1e9, 0.0
    for m, s in zip(masks, scores):
        cm = clean_mask(m)
        if cm is None:
            continue
        frac = float(cm.mean())
        # jewellery can be ~1% of the frame — small-category floors are lower
        small = category in ("accessories", "others")
        frac_lo = 0.003 if small else 0.02
        if not (frac_lo <= frac <= 0.90):
            continue  # noise-sized or background-sized — not a garment
        ys, xs = np.nonzero(cm)
        inside = (xs >= x1) & (xs <= x2) & (ys >= y1) & (ys <= y2)
        cover = float(inside.sum()) / box_area
        cover_lo = 0.05 if small else 0.15
        if cover < cover_lo:
            continue  # a sub-part fragment — the sleeves-only mask
        score = float(s) + 2.0 * min(1.0, cover) + 0.8 * frac
        touches = 0
        if xs.min() == 0:
            touches += 1
        if xs.max() == w - 1:
            touches += 1
        if ys.min() == 0:
            touches += 1
        if ys.max() == h - 1:
            touches += 1
        score -= touches * 0.5
        if not cm[int(cy), int(cx)]:
            score -= 1.0  # prefer masks covering the box centre (soft — small
                          # accessories may sit above or below it)
        if category in CATEGORY_ASPECT:
            aspect = (xs.max() - xs.min() + 1) / (ys.max() - ys.min() + 1)
            lo, hi = CATEGORY_ASPECT[category]
            if lo <= aspect <= hi:
                score += 0.5
        if score > best_score:
            best_score, best_mask, best_cover = score, cm, cover

    if best_mask is None:
        raise MattingError("no clean garment mask")
    # geometric-only background rejects live in cut_out (colour sanity check);
    # a large centred garment can legitimately touch every border.
    return best_mask, best_cover


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
    """Union the SAM2 mask with chroma-key evidence inside the box:
    - keyed regions that substantially overlap the mask recover light parts
      (shoe toes, hems) the segmenter left out;
    - for shoes, sibling keyed components of comparable size are the other
      shoe of the pair (SAM2 only ever masks one).
    Busy backgrounds self-reject in border_key_mask → no-op."""
    keyed = border_key_mask(img_arr, box, t=25)  # looser than the fallback
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
        if ratio > 0.3 or sibling:
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


def cut_out(img: Image.Image, box, category) -> Image.Image:
    """SAM2 → mask → transparent RGBA crop, centred on the 512 canvas.

    Chain: (1) box + positive/negative point prompts with garment-shaped
    mask selection; (2) if that yields nothing clean, whole-image automatic
    segmentation picking the proposal that matches the box; (3) colour
    sanity check — a mask hugging every border whose colour matches the
    border is background, never a garment."""
    w, h = img.width, img.height
    img_arr = np.asarray(img.convert("RGB"), dtype=np.uint8)
    predictor = state["sam"]
    predictor.set_image(img_arr)
    pos, neg = prompt_points(box, w, h)
    masks, scores, _logits = predictor.predict(
        point_coords=np.array(pos + neg, dtype=np.float32),
        point_labels=np.array([1] * len(pos) + [0] * len(neg), dtype=np.int32),
        box=np.array([box], dtype=np.float32),
        multimask_output=True,
    )
    mask = None
    try:
        mask, _cover = pick_garment_mask(masks, scores, w, h, box, category)
        print(f"[cutout] prompt pick frac={mask.mean():.3f} "
              f"touches_all={touches_all_borders(mask, w, h)} "
              f"looks_bg={mask_looks_like_background(img_arr, mask)}")
        if touches_all_borders(mask, w, h) and mask_looks_like_background(img_arr, mask):
            mask = None
    except MattingError:
        print("[cutout] prompt pick failed")

    if mask is None:
        mask = border_key_mask(img_arr, box)
        if mask is not None:
            print(f"[cutout] border-key fallback frac={mask.mean():.3f} "
                  f"touches_all={touches_all_borders(mask, w, h)} "
                  f"looks_bg={mask_looks_like_background(img_arr, mask)}")
        if mask is None or mask_looks_like_background(img_arr, mask):
            raise MattingError("no clean garment mask")

    # chroma-key evidence: grow the mask with key-based regions that overlap
    # it, recovering toes/hems (and shoe pairs) the segmenter missed
    try:
        mask = complete_mask_with_key(mask, img_arr, box, category)
    except Exception:
        print("[cutout] mask completion failed — using the raw mask")

    # stripes & slits: bridge narrow gaps so a striped sweater stays ONE
    # garment instead of shredding between its stripes (scales with image)
    try:
        iters = max(2, min(12, round(min(w, h) / 120)))
        mask = ndimage.binary_closing(mask, structure=np.ones((3, 3)), iterations=iters)
    except Exception:
        print("[cutout] mask closing failed — using the raw mask")

    # return the raw mask at ORIGINAL photo resolution — the browser overlays
    # it on the original photo and does the final cutout when the user hits
    # Done (mask directly on the photo, resize only then)
    return mask


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
async def matting(body: dict):
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
                mask = np.zeros((img.height, img.width), dtype=bool)
                stage_out = "manual"
            else:
                stage_out = "done"
            yield line({"stage": "normalize"})

            # green overlay PNG at ORIGINAL resolution: RGB = green tint,
            # alpha = keep mask. The browser draws it straight onto the
            # original photo; the final 512 cutout happens client-side.
            UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            fname = f"{uuid.uuid4().hex}.png"
            overlay = np.zeros((img.height, img.width, 4), dtype=np.uint8)
            overlay[..., 0] = 46
            overlay[..., 1] = 204
            overlay[..., 2] = 113
            overlay[..., 3] = (mask.astype(np.uint8) * 255)
            Image.fromarray(overlay).save(UPLOAD_DIR / fname)
            if state.get("sam_device") == "cuda":
                torch.cuda.empty_cache()
            yield line({
                "stage": stage_out,
                "url": f"/uploads/{fname}",
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
