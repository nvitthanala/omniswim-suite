# Training footage manifest

Video files in this directory are **deliberately not committed**. See `.gitignore`.

**Why.** This repository is public, and race footage is generally third-party
copyrighted material (broadcast, meet-production, or federation video) showing
identifiable athletes. Committing it would republish it, and git history on a
public host is effectively permanent — deletion does not reach forks or caches.
Nothing here is a judgement about any individual clip; it is the default that
keeps the repository distributable.

**What is committed instead** is this manifest: the identity, provenance and
checksum of every clip in the dataset. That is what makes the dataset
reproducible and auditable. A collaborator obtains the files separately, drops
them in this directory, and verifies them against the checksums below.

**Verify a local copy:**

```bash
sha256sum -c data/training/checksums.txt
```

---

## Clips

### 1. `jordan-crooks-17.93-50-free.mp4`

| Field | Value |
| ----- | ----- |
| Swimmer | Jordan Crooks |
| Event | 50 Freestyle |
| Result | 17.93 |
| Course | SCY |
| Lengths | 1 |
| Added | 2026-08-03 |
| Size | 11,604,453 bytes (11 MB) |
| SHA-256 | `81ab1f765bb1fb4840bc9bb6a2f7f8e4e75729397b46808382c16275dc2b1c01` |
| Source | Local file supplied by repository owner; original broadcaster/rights holder not recorded |
| Landmark ground truth | **None yet** — not tagged |
| Intended use | Local model work (workstream E). Not redistributed. |

**Note on suitability.** A 50 free is one length: it has a start, a breakout, a
stroke sequence and a finish, but **no turn**. It therefore exercises only part
of the tag state machine and cannot validate turn detection, per-length
segmentation across a wall, or the `UNPAIRED_TURN` handling that Fixture C
covers. It is a good first clip and an insufficient dataset. Longer events —
100s and 200s — are needed before any turn-related detection can be trained or
evaluated.

---

## Dataset gaps

Tracked here so the shortfall stays visible rather than being discovered during
training.

| Need | Status |
| ---- | ------ |
| Clips with turns (100s, 200s) | **missing** |
| Non-freestyle strokes (fly, back, breast) | **missing** |
| Individual medley | **missing** |
| LCM and SCM footage | **missing** |
| Women's races | **missing** |
| Any clip with tagged landmark ground truth | **missing** |
| Varied camera angles / fixed-camera footage | **missing** |

Broadcast footage pans, cuts and changes zoom, which is materially harder for a
pose model than a fixed side-on camera. Fixed-camera footage of ordinary meets
is likely to be more useful for training than clean broadcast video of elite
swims, and is also easier to obtain rights to.
