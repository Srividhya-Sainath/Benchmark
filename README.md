# Pathology Q&A UI

## GitHub Pages + Hugging Face

This UI can run as a static GitHub Pages site. In static mode it:

- loads the image manifest from `static/data/images.json`
- reads image files from a Hugging Face dataset repo
- saves annotations in the browser with `localStorage`
- exports annotations as a CSV download from the browser

Static hosting cannot save annotations back to the server automatically. Each reviewer should export their CSV when done.

### 1. Upload image data to Hugging Face

Create a Hugging Face dataset repo and upload the ROI folders with this layout:

```text
BRACS/ROI/<image files>
AGGC/ROI/<image files>
PANDA/ROI/<image files>
```

The UI uses normal browser `<img>` loading, so use browser-displayable images such as `.png`, `.jpg`, `.jpeg`, `.webp`, `.tif`, or `.tiff`. Whole-slide `.svs` files will not display directly in a standard browser image tag.

### 2. Point the UI at Hugging Face

Edit `static/config.js`:

```js
window.PATHOLOGY_QA_CONFIG = {
  mode: "static",
  manifestUrl: "./data/images.json",
  hfImageBaseUrl: "https://huggingface.co/datasets/USER/REPO/resolve/main",
  staticPassword: "pathqa2026",
  annotationStoragePrefix: "pathologyQaAnnotations",
};
```

Replace `USER/REPO` with your Hugging Face dataset repo.
Set `staticPassword` to the shared review password required by the GitHub Pages UI.

If the images live inside a subfolder in the HF dataset repo, rebuild the manifest with `--hf-prefix`:

```bash
python scripts/build_hf_manifest.py \
  --hf-base-url https://huggingface.co/datasets/USER/REPO/resolve/main \
  --hf-prefix path/inside/hf/repo
```

Otherwise, rebuild with:

```bash
python scripts/build_hf_manifest.py \
  --hf-base-url https://huggingface.co/datasets/USER/REPO/resolve/main
```

This writes:

```text
static/data/images.json
```

### 3. Publish to GitHub Pages

Push this folder to a GitHub repo, then enable Pages:

```text
Settings -> Pages -> Deploy from a branch -> main -> /root
```

The root `index.html` forwards to `static/index.html`, so no build step is needed.

## Local server mode

Run the local annotation app:

```bash
python /mnt/bulk-uranus/vidhya/naya/benchmark/pathology_qa_ui/server.py
```

Then open:

```text
http://127.0.0.1:8765
```

The shared password is configured in:

```text
/mnt/bulk-uranus/vidhya/naya/benchmark/pathology_qa_ui/auth_config.json
```

Annotations are saved automatically to:

```text
/mnt/bulk-uranus/vidhya/naya/benchmark/pathology_qa_ui/annotations/<username>.json
```

The CSV export is available from the app and at:

```text
http://127.0.0.1:8765/api/export.csv?user=<username>
```
