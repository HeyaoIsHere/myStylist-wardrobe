@echo off
rem One-shot setup + start for the matting service (Windows).
rem First run downloads torch (~2.5GB) and model weights (~800MB) — be patient.
rem On machines with an NVIDIA GPU the CUDA wheels are installed automatically
rem (~3s per photo); without one the service runs on CPU (15-30s per photo).
cd /d "%~dp0"

if not exist .venv (
    echo [1/4] Creating virtual environment...
    python -m venv .venv
)

call .venv\Scripts\activate.bat

echo [2/4] Installing dependencies (torch is large, this takes a while)...
python -m pip install --upgrade pip >nul
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

rem The mirror above ships CPU-only torch, which makes every photo take
rem 15-30s. When an NVIDIA GPU is present, swap in the CUDA wheels (same
rem base versions as requirements.txt — keep them in sync when upgrading).
nvidia-smi >nul 2>&1
if "%errorlevel%"=="0" (
    echo [2/4] NVIDIA GPU found - installing CUDA torch wheels...
    pip install "torch==2.14.0+cu126" "torchvision==0.29.0+cu126" --index-url https://mirror.sjtu.edu.cn/pytorch-wheels/cu126
) else (
    echo [2/4] No NVIDIA GPU - keeping CPU torch (15-30s per photo).
)

echo [3/4] Downloading models (GroundingDINO-tiny + SAM2-tiny)...
set HF_ENDPOINT=https://hf-mirror.com
python download-models.py

echo [4/4] Starting service on http://127.0.0.1:8001 ...
set PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
python -u -m uvicorn service:app --host 127.0.0.1 --port 8001
