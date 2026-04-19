#!/usr/bin/env python3
"""
Create NotebookLM notebook and load all AI Developer Accelerator curriculum content as sources.

Uploads curriculum markdown content from local scraped-content/ into a single
topic-organized notebook.

Prerequisites:
  1. pip install "notebooklm-py[browser]" && playwright install chromium
  2. notebooklm login  (one-time Google auth)

Usage:
  python setup-notebooklm.py             # full run
  python setup-notebooklm.py --dry-run   # preview mapping only
"""

import argparse
import asyncio
import sys
from pathlib import Path

SCRAPED_CONTENT = Path(__file__).parent / "scraped-content"

# Single notebook for all curriculum
NOTEBOOK_DEF = {
    "title": "AI Developer Accelerator - Skool Scrape",
    "markdown_paths": [
        "curriculum-only.md",
    ],
}

MAX_SOURCES_PER_NOTEBOOK = 50
SOURCE_DELAY_SECONDS = 2


def collect_markdown(paths: list[str]) -> list[Path]:
    """Gather all .md files under the given scraped-content-relative paths."""
    files = []
    for rel_path in paths:
        full_path = SCRAPED_CONTENT / rel_path
        if full_path.is_file() and full_path.suffix == ".md":
            files.append(full_path)
        elif full_path.is_dir():
            found = sorted(full_path.rglob("*.md"))
            files.extend(found)
        else:
            print(f"  WARNING: markdown path not found: {full_path}")
    return files


def label_file(file_path: Path) -> str:
    """Return a human-readable label for a file."""
    name = file_path.name
    try:
        return f"[markdown] {file_path.relative_to(SCRAPED_CONTENT)}"
    except ValueError:
        return f"[markdown] {name}"


def dry_run() -> None:
    """Print the notebook mapping without creating anything."""
    files = collect_markdown(NOTEBOOK_DEF["markdown_paths"])
    count = len(files)
    over = count > MAX_SOURCES_PER_NOTEBOOK

    marker = " ** EXCEEDS 50-SOURCE LIMIT **" if over else ""
    print(f"[{count:3d} sources] {NOTEBOOK_DEF['title']}{marker}")
    for f in files:
        print(f"    {label_file(f)}")
    print()

    print(f"Total: {count} sources")
    if over:
        print("\nERROR: Notebook exceeds the 50-source limit.", file=sys.stderr)
        sys.exit(1)
    print("Dry run complete. No notebooks were created.")


async def create_notebooks() -> None:
    """Create NotebookLM notebook and upload all sources."""
    from notebooklm import NotebookLMClient

    files = collect_markdown(NOTEBOOK_DEF["markdown_paths"])

    if len(files) > MAX_SOURCES_PER_NOTEBOOK:
        print(
            f"ERROR: '{NOTEBOOK_DEF['title']}' has {len(files)} sources "
            f"(max {MAX_SOURCES_PER_NOTEBOOK})",
            file=sys.stderr,
        )
        sys.exit(1)

    async with await NotebookLMClient.from_storage() as client:
        if not files:
            print(f"SKIP: '{NOTEBOOK_DEF['title']}' -- no files found")
            return

        print(f"\n{'='*60}")
        print(f"Creating notebook: {NOTEBOOK_DEF['title']} ({len(files)} sources)")
        print(f"{'='*60}")

        notebook = await client.notebooks.create(NOTEBOOK_DEF["title"])
        print(f"  Notebook ID: {notebook.id}")

        succeeded = 0
        failed = 0
        for i, file_path in enumerate(files, 1):
            try:
                print(f"  [{i}/{len(files)}] Adding: {label_file(file_path)} ...", end=" ", flush=True)
                source = await client.sources.add_file(notebook.id, file_path)
                await client.sources.wait_until_ready(notebook.id, source.id)
                print("OK")
                succeeded += 1
            except Exception as e:
                print(f"FAILED: {e}")
                failed += 1

            if i < len(files):
                await asyncio.sleep(SOURCE_DELAY_SECONDS)

        print(f"  Done: {succeeded} succeeded, {failed} failed")

    print(f"\nNotebook created. Open https://notebooklm.google.com to verify.")
    print(f"Notebook ID: {notebook.id}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create NotebookLM notebook from AI Developer Accelerator curriculum"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview notebook mapping without creating anything",
    )
    args = parser.parse_args()

    if args.dry_run:
        dry_run()
    else:
        asyncio.run(create_notebooks())


if __name__ == "__main__":
    main()
