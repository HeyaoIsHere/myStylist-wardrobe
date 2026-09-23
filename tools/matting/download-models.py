"""Pre-download model weights into tools/matting/models/ via hf-mirror.

  - GroundingDINO-tiny  (IDEA-Research/grounding-dino-tiny)  ~660MB
  - RMBG-1.4            (briaai/RMBG-1.4, remote code)       ~177MB  → PRIMARY
  - SAM2 tiny           (facebook/sam2-hiera-tiny, sam2_hiera_tiny.pt)  ~156MB  → fallback

Files are fetched with plain HTTP (stdlib urllib, redirects followed) instead
of huggingface_hub: the older huggingface_hub that ships with transformers v4
rejects the mirror's Xet-backed LFS responses ("Distant resource does not seem
to be on huggingface.co"), and a direct resolve URL download bypasses that
metadata check entirely. Downloads are skipped if already present.
"""
import os
import time
import urllib.request
from pathlib import Path

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

MODELS = Path(__file__).resolve().parent / "models"
ENDPOINT = os.environ["HF_ENDPOINT"].rstrip("/")

# (repo, path-in-repo, size label). Duplicated weights (pytorch_model.bin /
# model.pth) and mobile/onnx variants are intentionally not downloaded —
# transformers loads model.safetensors only.
DINO_FILES = [
    ("config.json", "1.6KB"),
    ("preprocessor_config.json", "0.5KB"),
    ("tokenizer.json", "0.7MB"),
    ("tokenizer_config.json", "1.2KB"),
    ("special_tokens_map.json", "0.1KB"),
    ("added_tokens.json", "0.1KB"),
    ("vocab.txt", "0.2MB"),
    ("model.safetensors", "660MB"),
]
RMBG_FILES = [
    ("config.json", "0.5KB"),
    ("MyConfig.py", "0.3KB"),
    ("briarmbg.py", "13KB"),
    ("preprocessor_config.json", "0.3KB"),
    ("model.safetensors", "176MB"),
]
SAM2_FILES = [("sam2_hiera_tiny.pt", "156MB")]


def fetch(repo: str, rel: str, dest: Path, tries: int = 3) -> bool:
    """GET {ENDPOINT}/{repo}/resolve/main/{rel} → dest. Returns True when the
    file exists afterwards (freshly downloaded or already present)."""
    if dest.exists() and dest.stat().st_size > 0:
        return True
    url = f"{ENDPOINT}/{repo}/resolve/main/{rel}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "myStylist-matting"})
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            tmp.replace(dest)
            return True
        except Exception as e:
            print(f"  attempt {attempt}/{tries} failed: {e}")
            tmp.unlink(missing_ok=True)
            time.sleep(2 * attempt)
    return False


def main() -> None:
    MODELS.mkdir(exist_ok=True)
    ok = True

    dino_dir = MODELS / "grounding-dino-tiny"
    print("GroundingDINO-tiny …")
    for rel, size in DINO_FILES:
        if not fetch("IDEA-Research/grounding-dino-tiny", rel, dino_dir / rel):
            ok = False
    print(f"  → {dino_dir}")

    rmbg_dir = MODELS / "rmbg-1.4"
    print("BRIA RMBG-1.4 (primary) …")
    for rel, size in RMBG_FILES:
        if not fetch("briaai/RMBG-1.4", rel, rmbg_dir / rel):
            ok = False
    print(f"  → {rmbg_dir}")

    sam2_dir = MODELS / "sam2"
    print("SAM2 tiny (fallback) …")
    for rel, size in SAM2_FILES:
        if not fetch("facebook/sam2-hiera-tiny", rel, sam2_dir / rel):
            ok = False
    print(f"  → {sam2_dir}")

    if ok:
        print("All models ready.")
    else:
        raise SystemExit("some downloads failed — re-run this script")


if __name__ == "__main__":
    main()
