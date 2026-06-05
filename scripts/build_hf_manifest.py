#!/usr/bin/env python3
"""Build a static image manifest for GitHub Pages + Hugging Face hosting."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from urllib.parse import quote


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"}
DEFAULT_DATASETS = {
    "BRACS": Path("/mnt/bulk-uranus/vidhya/naya/benchmark/BRACS/ROI"),
    "AGGC": Path("/mnt/bulk-uranus/vidhya/naya/benchmark/AGGC/ROI"),
    "PANDA": Path("/mnt/bulk-uranus/vidhya/naya/benchmark/PANDA/ROI"),
}


def load_metadata(dataset: str, root: Path) -> dict[str, dict[str, str]]:
    metadata_path = root / "metadata.csv"
    if not metadata_path.exists():
        return {}

    by_name: dict[str, dict[str, str]] = {}
    with metadata_path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if dataset == "PANDA":
                image_id = row.get("image_id", "").strip()
                if not image_id:
                    continue
                entry = by_name.setdefault(image_id, {"image_id": image_id, "_labels": ""})
                label = (row.get("label") or "").strip()
                if label:
                    labels = [value for value in entry.get("_labels", "").split("\n") if value]
                    if label not in labels:
                        labels.append(label)
                    entry["_labels"] = "\n".join(labels)
                    entry.setdefault("label", label)
                continue

            file_name = row.get("file_name", "").strip()
            if not file_name:
                continue
            by_name[file_name] = {key: value for key, value in row.items() if value}
            for prefix in ("train_", "test_", "val_"):
                by_name[prefix + file_name] = by_name[file_name]
    return by_name


def label_for_image(dataset: str, metadata: dict[str, str], filename: str) -> str:
    labels = [value for value in metadata.get("_labels", "").split("\n") if value]
    if not labels and metadata.get("label"):
        labels = [metadata["label"]]

    if dataset == "PANDA" and labels:
        lower_name = f"_{filename.lower()}_"
        for label in labels:
            if f"_{label.lower()}_" in lower_name:
                return label

    return labels[0] if len(labels) == 1 else ", ".join(labels)


def encode_path(path: str) -> str:
    return "/".join(quote(part) for part in path.split("/") if part)


def make_url(base_url: str, rel_path: str) -> str:
    if not base_url:
        return ""
    return f"{base_url.rstrip('/')}/{encode_path(rel_path)}"


def build_manifest(hf_base_url: str, hf_prefix: str) -> dict:
    images = []
    hf_prefix = hf_prefix.strip("/")

    for dataset, root in DEFAULT_DATASETS.items():
        metadata = load_metadata(dataset, root)
        if not root.exists():
            continue

        for image_path in sorted(root.iterdir(), key=lambda path: path.name.lower()):
            if image_path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue

            name = image_path.name
            stem = image_path.stem
            item_metadata = metadata.get(name) or metadata.get(stem.split("_", 1)[0], {})
            if dataset == "PANDA":
                image_id = name.split("_", 1)[0]
                item_metadata = metadata.get(image_id, item_metadata)

            label = label_for_image(dataset, item_metadata, name) or dataset
            rel_path = "/".join(part for part in (hf_prefix, dataset, "ROI", name) if part)
            images.append(
                {
                    "id": f"{dataset}/{name}",
                    "dataset": dataset,
                    "filename": name,
                    "hf_path": rel_path,
                    "url": make_url(hf_base_url, rel_path),
                    "metadata": {"label": label},
                }
            )

    return {"version": 1, "images": images}


def main() -> None:
    parser = argparse.ArgumentParser(description="Create static/data/images.json for the Pathology Q&A UI.")
    parser.add_argument(
        "--hf-base-url",
        default="",
        help="Example: https://huggingface.co/datasets/USER/REPO/resolve/main",
    )
    parser.add_argument(
        "--hf-prefix",
        default="",
        help="Optional folder prefix inside the Hugging Face dataset repo.",
    )
    parser.add_argument(
        "--output",
        default=str(Path(__file__).resolve().parents[1] / "static" / "data" / "images.json"),
    )
    args = parser.parse_args()

    manifest = build_manifest(args.hf_base_url, args.hf_prefix)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote {len(manifest['images'])} images to {output}")


if __name__ == "__main__":
    main()
