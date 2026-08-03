#!/usr/bin/env python3
"""Fetch the primary-source qualifying-standard PDFs for every division we model.

Downloads each published PDF to ``data/cutlines/sources/`` and records
``{url, filename, sha256, retrievedAt, pageCount}`` in
``data/cutlines/sources/manifest.json``.

The script is idempotent: re-running re-downloads each source, compares the
sha256 against the recorded one and reports ``NEW`` / ``UNCHANGED`` / ``CHANGED``
per file. Governing bodies revise these PDFs **in place** (the NCAA D1 file
already carries an "UPDATED 7/24/2025" stamp), so a CHANGED report means the
extracted JSON is stale and ``extract-cutlines.py`` must be re-run and the
numbers re-reviewed. Resolving a change is a deliberate human call, never
automatic.

Usage::

    python scripts/fetch-cutlines.py            # download + refresh manifest
    python scripts/fetch-cutlines.py --check    # exit 1 if any sha256 changed

Requires: pdfplumber (page counts). No competition value is ever derived here;
this script only archives bytes.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCES_DIR = REPO_ROOT / "data" / "cutlines" / "sources"
MANIFEST_PATH = SOURCES_DIR / "manifest.json"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36 omniswim-cutline-fetch/1.0"
)

# Every source we archive. `id` is the stable key used by extract-cutlines.py and
# by the `sourceId` provenance field on every emitted record.
SOURCES: list[dict[str, str]] = [
    {
        "id": "ncaa-d1-2025-26",
        "division": "D1",
        "season": "2025-2026",
        "genders": "MW",
        "filename": "2025-26D1XSW_QUALSTANDARDS.pdf",
        "url": "https://ncaaorg.s3.amazonaws.com/championships/sports/swimdive/d1/2025-26D1XSW_QUALSTANDARDS.pdf",
    },
    {
        "id": "ncaa-d2-men-2026-27",
        "division": "D2",
        "season": "2026-2027",
        "genders": "M",
        "filename": "2026-27D2MSW_QualStandards.pdf",
        "url": "https://ncaaorg.s3.amazonaws.com/championships/sports/swimdive/d2/2026-27D2MSW_QualStandards.pdf",
    },
    {
        "id": "ncaa-d2-women-2026-27",
        "division": "D2",
        "season": "2026-2027",
        "genders": "W",
        "filename": "2026-27D2WSW_QualStandards.pdf",
        "url": "https://ncaaorg.s3.amazonaws.com/championships/sports/swimdive/d2/2026-27D2WSW_QualStandards.pdf",
    },
    {
        "id": "ncaa-d3-2026-27",
        "division": "D3",
        "season": "2026-2027",
        "genders": "MW",
        "filename": "2026-27D3XSW_QualifyingStandards.pdf",
        "url": "https://ncaaorg.s3.amazonaws.com/championships/sports/swimdive/d3/2026-27D3XSW_QualifyingStandards.pdf",
    },
    {
        "id": "naia-2026-27",
        "division": "NAIA",
        "season": "2026-2027",
        "genders": "MW",
        "filename": "2026-27-SD-Qualifying-Standards-wo-Relays.pdf",
        "url": "https://www.naia.org/wp-content/uploads/2026/05/2026-27-SD-Qualifying-Standards-wo-Relays.pdf",
    },
]


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=90) as resp:  # noqa: S310 - fixed https allowlist
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status} for {url}")
        return resp.read()


def page_count(path: Path) -> int:
    import pdfplumber  # imported lazily so --help works without the dep

    with pdfplumber.open(path) as pdf:
        return len(pdf.pages)


def load_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.exists():
        return {"sources": []}
    with MANIFEST_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if any upstream sha256 differs from the manifest",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="skip downloading; only re-derive the manifest from files already on disk",
    )
    args = parser.parse_args()

    SOURCES_DIR.mkdir(parents=True, exist_ok=True)
    previous = {entry["id"]: entry for entry in load_manifest().get("sources", [])}

    entries: list[dict[str, Any]] = []
    changed_ids: list[str] = []
    failures: list[str] = []

    for src in SOURCES:
        dest = SOURCES_DIR / src["filename"]
        if args.offline:
            if not dest.exists():
                failures.append(f"{src['id']}: --offline but {dest} is missing")
                continue
            payload = dest.read_bytes()
        else:
            try:
                payload = download(src["url"])
            except (urllib.error.URLError, RuntimeError, TimeoutError) as exc:
                failures.append(f"{src['id']}: download failed - {exc}")
                continue
            if not payload.startswith(b"%PDF"):
                failures.append(
                    f"{src['id']}: response from {src['url']} is not a PDF "
                    f"(first bytes {payload[:8]!r})"
                )
                continue
            dest.write_bytes(payload)

        digest = sha256_of(payload)
        prior = previous.get(src["id"])
        if prior is None:
            status = "NEW"
        elif prior.get("sha256") == digest:
            status = "UNCHANGED"
        else:
            status = "CHANGED"
            changed_ids.append(src["id"])

        entry: dict[str, Any] = {
            "id": src["id"],
            "division": src["division"],
            "season": src["season"],
            "genders": src["genders"],
            "url": src["url"],
            "filename": src["filename"],
            "sha256": digest,
            "bytes": len(payload),
            "pageCount": page_count(dest),
            "retrievedAt": (
                prior["retrievedAt"]
                if status == "UNCHANGED" and prior and prior.get("retrievedAt")
                else _dt.datetime.now(_dt.timezone.utc)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z")
            ),
        }
        if status == "CHANGED" and prior:
            entry["previousSha256"] = prior.get("sha256")
            entry["previousRetrievedAt"] = prior.get("retrievedAt")
        entries.append(entry)
        print(f"{status:<9} {src['id']:<22} {digest[:16]}  {entry['pageCount']}p  {dest.name}")

    if failures:
        print("\nFETCH FAILED:", file=sys.stderr)
        for line in failures:
            print(f"  - {line}", file=sys.stderr)
        print(
            "\nRefusing to write a partial manifest. No source was replaced by a guess.",
            file=sys.stderr,
        )
        return 2

    manifest = {
        "description": (
            "Primary-source qualifying-standard PDFs. Every cutline record in "
            "data/cutlines/*.json traces to one of these by sourceId + sha256. "
            "Regenerate with scripts/fetch-cutlines.py then scripts/extract-cutlines.py."
        ),
        "generatedAt": _dt.datetime.now(_dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "sources": entries,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {MANIFEST_PATH.relative_to(REPO_ROOT)} ({len(entries)} sources)")

    if changed_ids:
        print(
            "\n*** UPSTREAM REVISION DETECTED ***\n"
            f"    sha256 changed for: {', '.join(changed_ids)}\n"
            "    data/cutlines/*.json is now stale. Re-run scripts/extract-cutlines.py\n"
            "    and review the diff before trusting any cut tag.",
            file=sys.stderr,
        )
        if args.check:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
