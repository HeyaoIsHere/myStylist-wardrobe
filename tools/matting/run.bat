@echo off
rem One-shot setup + start for the matting service (Windows).
rem First run downloads torch (~2.5GB) and model weights (~800MB) — be patient.
cd /d "%~dp0"

if not exist .venv (
    echo [1/4] Creating virtual environment...
    python -m venv .venv
)

call .venv\Scripts\activate.bat

echo [2/4] Installing dependencies (torch is large, this takes a while)...
python -m pip install --upgrade pip >nul
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

echo [3/4] Downloading models (GroundingDINO-tiny + SAM2-tiny)...
set HF_ENDPOINT=https://hf-mirror.com
python download-models.py

echo [4/4] Starting service on http://127.0.0.1:8001 ...
set PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
python -u -m uvicorn service:app --host 127.0.0.1 --port 8001
