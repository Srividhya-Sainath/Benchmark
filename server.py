#!/usr/bin/env python3
"""Local annotation UI for pathology ROI question-answer collection."""

from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import json
import mimetypes
import os
import posixpath
import re
import shutil
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
AUTH_CONFIG_PATH = APP_DIR / "auth_config.json"
ANNOTATIONS_DIR = APP_DIR / "annotations"
DEFAULT_PASSWORD = "pathqa2026"
IMAGE_ROOTS = {
    "BRACS": Path("/mnt/bulk-uranus/vidhya/naya/benchmark/BRACS/ROI"),
    "AGGC": Path("/mnt/bulk-uranus/vidhya/naya/benchmark/AGGC/ROI"),
    "PANDA": Path("/mnt/bulk-uranus/vidhya/naya/benchmark/PANDA/ROI"),
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"}
SESSION_COOKIE = "pathology_qa_session"


def read_auth_config() -> dict[str, str]:
    if AUTH_CONFIG_PATH.exists():
        with AUTH_CONFIG_PATH.open(encoding="utf-8") as f:
            config = json.load(f)
        if isinstance(config, dict) and config.get("password") and config.get("secret"):
            return {"password": str(config["password"]), "secret": str(config["secret"])}

    config = {"password": DEFAULT_PASSWORD, "secret": os.urandom(32).hex()}
    with AUTH_CONFIG_PATH.open("w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return config


def validate_password(password: str) -> bool:
    expected = read_auth_config()["password"]
    return hmac.compare_digest(password, expected)


def clean_user_name(user: str) -> str:
    user = re.sub(r"\s+", " ", str(user).strip())
    if not user:
        raise ValueError("Name is required")
    if len(user) > 80:
        raise ValueError("Name is too long")
    return user


def user_file_stem(user: str) -> str:
    user = clean_user_name(user)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", user.lower()).strip("_")
    return stem or hashlib.sha256(user.encode("utf-8")).hexdigest()[:16]


def annotation_path(user: str) -> Path:
    return ANNOTATIONS_DIR / f"{user_file_stem(user)}.json"


def read_annotations(user: str) -> dict:
    clean_user = clean_user_name(user)
    path = annotation_path(clean_user)
    if not path.exists():
        return {"version": 1, "user": clean_user, "items": {}, "updated_at": None}
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("version", 1)
    data["user"] = clean_user
    data.setdefault("items", {})
    data.setdefault("updated_at", None)
    return data


def make_session_cookie(user: str) -> str:
    clean_user = clean_user_name(user)
    payload = base64.urlsafe_b64encode(json.dumps({"user": clean_user}, separators=(",", ":")).encode("utf-8")).decode("ascii").rstrip("=")
    secret = read_auth_config()["secret"].encode("utf-8")
    signature = hmac.new(secret, payload.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def read_session_cookie(cookie_header: str | None) -> str | None:
    if not cookie_header:
        return None
    cookies = {}
    for part in cookie_header.split(";"):
        if "=" not in part:
            continue
        key, value = part.strip().split("=", 1)
        cookies[key] = value
    token = cookies.get(SESSION_COOKIE)
    if not token or "." not in token:
        return None
    payload, signature = token.rsplit(".", 1)
    secret = read_auth_config()["secret"].encode("utf-8")
    expected = hmac.new(secret, payload.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        padded = payload + "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        return clean_user_name(data.get("user", ""))
    except (ValueError, json.JSONDecodeError, TypeError):
        return None


def write_json(path: Path, data: dict) -> None:
    data["updated_at"] = int(time.time())
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
    tmp_path.replace(path)


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
            by_name[file_name] = {k: v for k, v in row.items() if v}
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


def build_manifest() -> list[dict]:
    images: list[dict] = []
    for dataset, root in IMAGE_ROOTS.items():
        metadata = load_metadata(dataset, root)
        if not root.exists():
            continue

        for image_path in sorted(root.iterdir(), key=lambda p: p.name.lower()):
            if image_path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue

            name = image_path.name
            stem = image_path.stem
            item_metadata = metadata.get(name) or metadata.get(stem.split("_", 1)[0], {})
            if dataset == "PANDA":
                image_id = name.split("_", 1)[0]
                item_metadata = metadata.get(image_id, item_metadata)

            label = label_for_image(dataset, item_metadata, name) or dataset
            image_id = f"{dataset}/{name}"
            images.append(
                {
                    "id": image_id,
                    "dataset": dataset,
                    "filename": name,
                    "path": str(image_path),
                    "url": f"/image/{dataset}/{name}",
                    "metadata": {"label": label},
                }
            )
    return images


def annotation_rows(user: str) -> list[dict[str, str]]:
    data = read_annotations(user)
    images_by_id = {image["id"]: image for image in build_manifest()}
    rows: list[dict[str, str]] = []
    for image_id, item in sorted(data.get("items", {}).items()):
        image = images_by_id.get(image_id, {})
        qa_pairs = item.get("qa", [])
        for index, qa in enumerate(qa_pairs, start=1):
            question = str(qa.get("question", "")).strip()
            answer = str(qa.get("answer", "")).strip()
            if not question and not answer:
                continue
            rows.append(
                {
                    "user": data.get("user", ""),
                    "dataset": image.get("dataset", ""),
                    "filename": image.get("filename", image_id),
                    "image_id": image_id,
                    "qa_index": str(index),
                    "question": question,
                    "answer": answer,
                    "notes": str(item.get("notes", "")).strip(),
                    "updated_at": str(item.get("updated_at", "")),
                }
            )
    return rows


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def authenticated_user(self, requested_user: str) -> str | None:
        try:
            clean_requested = clean_user_name(requested_user)
        except ValueError:
            return None
        session_user = read_session_cookie(self.headers.get("Cookie"))
        if session_user != clean_requested:
            return None
        return clean_requested

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/":
            self.serve_file(STATIC_DIR / "index.html")
            return
        if parsed.path == "/api/images":
            self.send_json({"images": build_manifest()})
            return
        if parsed.path == "/api/annotations":
            user = query.get("user", [""])[0]
            self.send_user_annotations(user)
            return
        if parsed.path == "/api/export.csv":
            user = query.get("user", [""])[0]
            self.send_user_csv(user)
            return
        if parsed.path.startswith("/image/"):
            self.serve_image(parsed.path)
            return
        if parsed.path.startswith("/static/"):
            rel = parsed.path.removeprefix("/static/")
            safe_rel = posixpath.normpath(unquote(rel)).lstrip("/")
            static_path = (STATIC_DIR / safe_rel).resolve()
            if not static_path.is_relative_to(STATIC_DIR.resolve()):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.serve_file(static_path)
            return
        if parsed.path in {"/styles.css", "/app.js", "/config.js"} or parsed.path.startswith("/data/"):
            rel = parsed.path.lstrip("/")
            safe_rel = posixpath.normpath(unquote(rel)).lstrip("/")
            static_path = (STATIC_DIR / safe_rel).resolve()
            if not static_path.is_relative_to(STATIC_DIR.resolve()):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.serve_file(static_path)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/api/login":
            self.handle_login()
            return

        if parsed.path != "/api/annotations":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        user = query.get("user", [""])[0]
        clean_user = self.authenticated_user(user)
        if clean_user is None:
            self.send_error(HTTPStatus.UNAUTHORIZED, "Login required")
            return

        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length)
        try:
            data = json.loads(payload.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON")
            return

        if not isinstance(data, dict):
            self.send_error(HTTPStatus.BAD_REQUEST, "Expected JSON object")
            return

        data["version"] = 1
        data["user"] = clean_user
        if not isinstance(data.get("items"), dict):
            data["items"] = {}
        path = annotation_path(clean_user)
        write_json(path, data)
        self.send_json(read_annotations(clean_user))

    def handle_login(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length)
        try:
            data = json.loads(payload.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON")
            return

        try:
            user = clean_user_name(data.get("user", ""))
        except ValueError as exc:
            self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
            return

        if not validate_password(str(data.get("password", ""))):
            self.send_error(HTTPStatus.UNAUTHORIZED, "Incorrect password")
            return

        cookie = make_session_cookie(user)
        response = json.dumps(read_annotations(user), ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Set-Cookie", f"{SESSION_COOKIE}={cookie}; Path=/; SameSite=Lax")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def send_user_annotations(self, user: str) -> None:
        clean_user = self.authenticated_user(user)
        if clean_user is None:
            self.send_error(HTTPStatus.UNAUTHORIZED, "Login required")
            return
        self.send_json(read_annotations(clean_user))

    def send_user_csv(self, user: str) -> None:
        clean_user = self.authenticated_user(user)
        if clean_user is None:
            self.send_error(HTTPStatus.UNAUTHORIZED, "Login required")
            return
        self.send_csv(clean_user, annotation_rows(clean_user))

    def serve_image(self, path: str) -> None:
        parts = [unquote(part) for part in path.split("/") if part]
        if len(parts) != 3:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        _, dataset, filename = parts
        if dataset not in IMAGE_ROOTS or "/" in filename or "\\" in filename:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        image_path = IMAGE_ROOTS[dataset] / filename
        if image_path.suffix.lower() not in IMAGE_EXTENSIONS or not image_path.exists():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.serve_file(image_path)

    def serve_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(path.stat().st_size))
        self.end_headers()
        with path.open("rb") as f:
            try:
                shutil.copyfileobj(f, self.wfile)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def send_json(self, data: dict) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_csv(self, user: str, rows: list[dict[str, str]]) -> None:
        import io

        fieldnames = [
            "user",
            "dataset",
            "filename",
            "image_id",
            "qa_index",
            "question",
            "answer",
            "notes",
            "updated_at",
        ]
        out = io.StringIO()
        writer = csv.DictWriter(out, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
        payload = out.getvalue().encode("utf-8")

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        export_name = "".join(char if char.isalnum() or char in ("-", "_") else "_" for char in user)
        self.send_header("Content-Disposition", f"attachment; filename={export_name}_qa_annotations.csv")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Run the pathology Q&A annotation UI.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Pathology Q&A UI: http://{args.host}:{args.port}")
    print(f"Auth config: {AUTH_CONFIG_PATH}")
    print(f"Saving annotations to: {ANNOTATIONS_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server")


if __name__ == "__main__":
    main()
