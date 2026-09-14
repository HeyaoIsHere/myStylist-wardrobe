"""One-shot pipeline smoke test: POST an image, print the NDJSON stages.

Usage: python test_pipeline.py path/to/photo.jpg
"""
import base64, json, time, urllib.request, sys

if len(sys.argv) < 2:
    print("Usage: python test_pipeline.py path/to/photo.jpg")
    sys.exit(1)
img_path = sys.argv[1]
raw = open(img_path, "rb").read()
dataurl = "data:image/jpeg;base64," + base64.b64encode(raw).decode()
req = urllib.request.Request(
    "http://127.0.0.1:8001/matting",
    data=json.dumps({"image": dataurl}).encode(),
    headers={"Content-Type": "application/json"},
)
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        for line in r:
            print(f"{time.time()-t0:5.1f}s {line.decode().strip()}")
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:500])
