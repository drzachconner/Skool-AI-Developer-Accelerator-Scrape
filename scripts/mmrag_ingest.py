#!/usr/bin/env python3
"""Ingest Skool AI Developer Accelerator per-lesson files into the local mmrag ChromaDB.

Creates/uses the `skool-ai-developer-accelerator` collection. Walks the curriculum
source tree:
- scraped-content/02-Classroom/**/content.md (128 lessons)

Excludes community posts (01-Community-Posts/) and metadata per the
Scrapes/CLAUDE.md "curriculum only" rule.

Upserts by md5(source + chunk_index), so re-runs are idempotent and safe to
resume after rate-limit bailouts.
"""
import hashlib
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib import request as urlrequest
from urllib.error import URLError

import chromadb

MMRAG_DIR = os.path.expanduser("~/.mmrag")
CHROMA_PATH = os.path.join(MMRAG_DIR, "chromadb")
CONFIG_PATH = os.path.join(MMRAG_DIR, "config.json")

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRAPED = REPO_ROOT / "scraped-content"

COLLECTION_NAME = "skool-ai-developer-accelerator"
# Curriculum directories under 02-Classroom
CLASSROOM_DIR = SCRAPED / "02-Classroom"

with open(CONFIG_PATH) as f:
    config = json.load(f)

CHUNK_SIZE = config.get("text_chunk_size", 4000)
CHUNK_OVERLAP = config.get("text_chunk_overlap", 200)
EMBED_DIM = 768  # nomic-embed-text fixed dimensionality
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("MMRAG_EMBED_MODEL", "nomic-embed-text")

chroma_client = chromadb.PersistentClient(path=CHROMA_PATH)


def chunk_text(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start = end - overlap
        if start >= len(text):
            break
    return chunks


def _ollama_embed(batch):
    payload = json.dumps({"model": EMBED_MODEL, "input": batch}).encode("utf-8")
    req = urlrequest.Request(
        f"{OLLAMA_URL}/api/embed",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=300) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    return body["embeddings"]


def get_embeddings(texts, batch_size=20):
    all_embeddings = []
    for i in range(0, len(texts), batch_size):
        batch = [t[:8000] for t in texts[i:i + batch_size]]
        backoff = 5
        for attempt in range(5):
            try:
                all_embeddings.extend(_ollama_embed(batch))
                break
            except (URLError, TimeoutError, json.JSONDecodeError) as e:
                if attempt < 4:
                    print(f"  Ollama embed retry {attempt + 1}/5 after {backoff}s ({e})", flush=True)
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 60)
                    continue
                print(f"  FATAL: Ollama embed failed after 5 retries: {e}", flush=True)
                return None
    return all_embeddings


def gather_files():
    """Walk all lesson content.md files under 02-Classroom."""
    files = []
    if CLASSROOM_DIR.exists():
        for content_md in sorted(CLASSROOM_DIR.rglob("content.md")):
            # Determine course/module/lesson context
            parts = content_md.parts
            try:
                classroom_idx = parts.index("02-Classroom")
                course_name = parts[classroom_idx + 1] if classroom_idx + 1 < len(parts) else "Unknown"
                module_name = parts[classroom_idx + 2] if classroom_idx + 2 < len(parts) else "Unknown"
                section = f"{course_name}/{module_name}"
            except (ValueError, IndexError):
                section = "classroom"
            files.append((content_md, section))
    return files


def main():
    collection = chroma_client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )
    existing_meta = collection.get(include=["metadatas"])
    existing_sources = {m["source"] for m in existing_meta["metadatas"] if "source" in m}
    print(f"Collection '{COLLECTION_NAME}' has {collection.count()} chunks from {len(existing_sources)} sources", flush=True)

    discovered = gather_files()
    to_ingest = []
    skipped = 0
    empty = 0
    for path, section in discovered:
        src = str(path)
        if src in existing_sources:
            skipped += 1
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore").strip()
        except Exception:
            continue
        if len(text) < 20:
            empty += 1
            continue
        to_ingest.append((src, section, text, path.suffix.lower()))

    print(f"Discovered: {len(discovered)} files", flush=True)
    print(f"Skipped (already ingested): {skipped}", flush=True)
    print(f"Skipped (empty): {empty}", flush=True)
    print(f"To ingest: {len(to_ingest)}", flush=True)
    if not to_ingest:
        print("Nothing to ingest.", flush=True)
        return

    BATCH = 10
    total_chunks = 0
    total_files = 0
    for b in range(0, len(to_ingest), BATCH):
        batch = to_ingest[b:b + BATCH]
        ids, docs, metas = [], [], []
        for src, section, text, ext in batch:
            now = datetime.now().isoformat(timespec="seconds")
            chunks = chunk_text(text)
            for i, ch in enumerate(chunks):
                ids.append(hashlib.md5(f"{src}::{i}".encode()).hexdigest())
                docs.append(ch)
                metas.append({
                    "source": src,
                    "filename": Path(src).name,
                    "section": section,
                    "file_ext": ext or ".md",
                    "type": "text",
                    "chunk_index": i,
                    "total_chunks": len(chunks),
                    "ingested_at": now,
                })
        if not docs:
            continue
        embeddings = get_embeddings(docs)
        if embeddings is None:
            print(f"  Batch {b // BATCH + 1}: SKIPPED (rate limited)", flush=True)
            time.sleep(120)
            continue
        if len(embeddings) != len(docs):
            print(f"  WARN: embedding count mismatch ({len(embeddings)}/{len(docs)}), skipping", flush=True)
            continue
        collection.upsert(ids=ids, documents=docs, embeddings=embeddings, metadatas=metas)
        total_chunks += len(docs)
        total_files += len(batch)
        done = min(b + BATCH, len(to_ingest))
        print(f"  Batch {b // BATCH + 1}: +{len(docs)} chunks ({done}/{len(to_ingest)} files) [collection total: {collection.count()}]", flush=True)
        time.sleep(2)

    print(f"\nDone. Added {total_chunks} chunks from {total_files} files.", flush=True)
    print(f"Collection now has {collection.count()} total chunks.", flush=True)


if __name__ == "__main__":
    main()
