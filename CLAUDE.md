# Skool AI Developer Accelerator Scraper

## Content Authority Hierarchy

When processing, curating, or applying knowledge from this scrape:
1. **Brandon Hancock** (community creator) — his posts, course content, and announcements are the authoritative source of truth
2. **Classroom modules/courses** — structured educational content always takes priority
3. **Other community members** — valuable supplementary patterns but secondary to Brandon and classroom content
4. When community member advice conflicts with Brandon's guidance or classroom material, always follow Brandon/classroom

## Project Overview

Browser automation tool that scrapes the "AI Developer Accelerator" Skool community (skool.com/ai-developer-accelerator) to extract educational content about full-stack AI development — posts, classroom courses/lessons, attached resources, and community discussions.

**Community:** PUBLIC, free, 10.8K members. Creator: Brandon Hancock. Focus: full-stack AI development, Claude Code vs Cursor comparisons, MCP content.

## Tech Stack

- **Runtime:** Node.js (CommonJS)
- **Browser Automation:** Playwright + playwright-extra with stealth plugin
- **HTTP Client:** Axios (for file downloads with cookie auth)
- **Config:** dotenv (.env for credentials)

## Architecture

### Scripts

| Script | Purpose | Run Command |
|--------|---------|-------------|
| `downloader.js` | Main scraper — login, classroom (sidebar nav), posts, about | `npm run scrape` |
| `resource-downloader-v2.js` | Download .docx/.pdf/.md resources via Skool API signed URLs | `npm run resources:v2` |
| `post-process.js` | Generate master index, high-value digest, curriculum-only, convert HTML, extract skills, compile transcripts | `npm run post-process` |
| `orchestrate.js` | Full pipeline: scrape → resources → post-process | `npm run full-run` |

### Scraping Strategy

- Exploits Next.js SSR `__NEXT_DATA__` JSON from Skool pages instead of fragile DOM parsing
- **Sidebar-click navigation** for lessons: navigates to course page once, then clicks lessons in sidebar
- Uses stealth plugin to avoid bot detection
- Implements infinite scroll + API pagination for community post discovery
- Post URL deduplication: strips `?p=` query params before comparing
- Progress tracking via `scraped-content/progress.json` for resumable runs
- Rate-limited: 1.5–3.5s random delays between requests
- **groupId auto-discovery** from `__NEXT_DATA__` (no hardcoded value needed)

### Content Prioritization

Post-processing generates tiered outputs:

| Output | Description |
|--------|-------------|
| `curriculum-only.md` | Structured course content ONLY — zero community posts. Clean for NotebookLM/toolkit ingestion. |
| `high-value-posts.md` | Curated digest: 3+ upvotes, pinned, or creator posts only |
| `master-index.md` | Full index with CORE CURRICULUM section first, COMMUNITY POSTS second |
| `posts-metadata.json` | All posts with tier tags: `creator`, `high`, `medium`, `low` |

**Tier definitions:**
- `creator` — Posts by Brandon Hancock (community owner)
- `high` — 5+ upvotes or pinned
- `medium` — 2-4 upvotes
- `low` — 0-1 upvotes

### Output Structure

```
scraped-content/
├── 01-Community-Posts/     # All community posts with comments, links, screenshots
│   └── {post-name}/
│       ├── _nextdata.json  # Raw Skool API data
│       ├── content.md      # Extracted markdown
│       ├── comments.md     # Thread comments
│       ├── metadata.json   # Post metadata with tier tag
│       ├── links.md        # Extracted hyperlinks
│       ├── page.html       # Full HTML snapshot
│       └── screenshot.png  # Visual capture
├── 02-Classroom/           # All courses and lessons
│   └── {course-name}/
│       ├── _course-meta.json
│       ├── _course-tree.json
│       ├── _lessons-index.json
│       └── {module}/{lesson}/
│           └── resources/
├── 03-About/               # Community info page
├── curriculum-only.md      # Clean curriculum digest (no posts)
├── high-value-posts.md     # Curated high-value post digest
├── master-index.md         # Full content index
├── posts-metadata.md       # Post metadata summary with tiers
├── posts-metadata.json     # Machine-readable metadata
├── all-transcripts.md      # Compiled transcripts
├── progress.json           # Resume state
├── report.json             # Run statistics
└── SUMMARY.md              # Human-readable stats
```

## Environment Variables

Required in `.env`:
- `EMAIL` — Skool account email
- `PASSWORD` — Skool account password
- `HEADLESS` — Set to `false` to show browser (default: `true`)

## Workflow

```
# Full automated pipeline:
npm run full-run

# Or step by step:
1. npm run scrape          # Scrape classroom + posts + about
2. npm run resources:v2    # Download classroom resources via Skool API
3. npm run post-process    # Generate all indexes, digests, and extractions

# Force re-scrape:
npm run scrape:force       # Re-scrape all lessons
```

## NotebookLM Notebooks

| Notebook | ID | Sources | Purpose |
|----------|----|---------|---------|
| AI Developer Accelerator - Skool Scrape | `b4dc4b1c-61f6-4193-b0f1-9a363aa9ebf9` | 1 | Queryable digest of all 128 curriculum lessons + Brandon Hancock's canonical course structure. Source: `scraped-content/curriculum-only.md`. |

Query:
```bash
notebooklm-query --notebook "AI Developer Accelerator - Skool Scrape" "your question"
```

## mmrag Collection

| Collection | Chunks | Sources | Purpose |
|------------|--------|---------|---------|
| `skool-ai-developer-accelerator` | 334 | 128 | Per-lesson retrieval across all classroom modules (excludes community posts per Scrapes/CLAUDE.md). |

Ingestion: `python3 scripts/mmrag_ingest.py` (idempotent via md5 dedup, **path-based** — drop the collection before re-ingesting refreshed content).

**Embeddings:** local Ollama `nomic-embed-text` (768d, free). Requires `ollama serve` running and `ollama pull nomic-embed-text`. Override with `MMRAG_EMBED_MODEL` env var. Queries must use the same model.

Smoke-tested query (see [ai-developer-accelerator-notebooklm.md](~/.claude/projects/-Users-zachconnermba-Code/memory/ai-developer-accelerator-notebooklm.md)):
- Query: "What are the key steps to build a full-stack AI application?"
- Expected: High-relevance returns from Module X, Lesson Y about architecture fundamentals

## Security

- Never commit `.env` — it is in `.gitignore`
- Credentials are used only for Skool login; cookies are ephemeral per browser session
- Stealth plugin modifies browser fingerprint to avoid detection

## Completed Work

- Skool scrape completed: 128 classroom lessons extracted with markdown content
- Post-processing: `curriculum-only.md` generated (38K words, 128 lessons)
- NotebookLM setup script created: `setup-notebooklm.py` creates notebook and loads `curriculum-only.md` as source
- NotebookLM notebook created (2026-04-19): `AI Developer Accelerator - Skool Scrape` with ID `b4dc4b1c-61f6-4193-b0f1-9a363aa9ebf9`
- mmrag ingestion script created: `scripts/mmrag_ingest.py` adapts LBP pattern for 128 per-lesson files
- 2026-05-03: fresh re-scrape (force-lessons), curriculum-only.md regenerated (980K, was 879K), NotebookLM source replaced, mmrag re-ingested with local Ollama (`nomic-embed-text`, 768d) — paid Gemini API removed.
