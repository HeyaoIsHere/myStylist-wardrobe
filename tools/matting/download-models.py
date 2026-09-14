"""Pre-download model weights into tools/matting/models/ via hf-mirror.

  - GroundingDINO-tiny  (IDEA-Research/grounding-dino-tiny)  ~660MB
  - SAM2 tiny           (facebook/sam2-hiera-tiny, sam2_hiera_tiny.pt)  ~156MB

Run this BEFORE starting the service. Downloads are skipped if already present.
"""
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

MODELS = Path(__file__).resolve().parent / "models"

try:
    from huggingface_hub import hf_hub_download, snapshot_download
except ImportError:
    print("huggingface_hub missing — install requirements.txt first")
    sys.exit(1)


def main() -> None:
    MODELS.mkdir(exist_ok=True)

    dino_dir = MODELS / "grounding-dino-tiny"
    if (dino_dir / "config.json").exists():
        print(f"GroundingDINO-tiny already at {dino_dir}")
    else:
        print("Downloading GroundingDINO-tiny (~660MB) …")
        snapshot_download("IDEA-Research/grounding-dino-tiny", local_dir=str(dino_dir))
        print(f"GroundingDINO-tiny saved to {dino_dir}")

    sam2_dir = MODELS / "sam2"
    sam2_ckpt = sam2_dir / "sam2_hiera_tiny.pt"
    if sam2_ckpt.exists():
        print(f"SAM2 tiny already at {sam2_ckpt}")
    else:
        print("Downloading sam2_hiera_tiny.pt (~156MB) …")
        sam2_dir.mkdir(exist_ok=True)
        hf_hub_download("facebook/sam2-hiera-tiny", "sam2_hiera_tiny.pt", local_dir=str(sam2_dir))
        print(f"SAM2 tiny saved to {sam2_ckpt}")

    print("All models ready.")


if __name__ == "__main__":
    main()
