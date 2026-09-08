# hts-manager

An internal tool for managing Illumina sequencing run output and getting reads
into Virtool. Point it at a directory of Illumina run folders; it indexes the
`*.fastq.gz` / `*.fq.gz` files (name, size, and run metadata parsed from the
run-folder name + filename), and presents a searchable list behind a shared PIN.
Each row has a one-click **Upload** button; a background worker uploads queued
files one at a time to Virtool, survives restarts, and marks each file
`uploaded` on success.

Originally scoped as a short-lived internal tool, hts-manager is now on a path
to become a production service for the sequencing pipeline — see
[Roadmap](#roadmap) for where it's headed.

## Stack

TanStack Start (React 19, Router + Query), TypeScript, Vite, better-sqlite3,
zod, undici, Tailwind CSS v4 + shadcn/ui. Package manager: pnpm.
Node 24.

## Getting started

```bash
pnpm install
cp .env.example .env   # fill in HTSM_PIN, HTSM_SESSION_SECRET, HTSM_SCAN_PATH, VT_* creds
pnpm dev               # http://localhost:3000

# production
pnpm build && pnpm start
```

On boot the app scans `HTSM_SCAN_PATH` once, then keeps the file list and the two
top-bar indicators (scanning / upload activity) live; **Scan now** re-scans on
demand.

### Disposable Docker test environment

The test Compose configuration mounts local fake sequencer output from
`test/input` and keeps both the destination files and SQLite database in the
same container-local tmpfs:

```bash
docker compose -f compose.test.yaml up --build
```

Open <http://localhost:3000> and log in with the test PIN `test`. The `test/`
directory is ignored by Git, so local fixture data is never committed. The
database and transferred output are both discarded when the test container is
stopped.

## Configuration

All configuration is via env vars — see [`.env.example`](./.env.example); there
are no CLI options. Required to boot are `HTSM_PIN` and `HTSM_SESSION_SECRET`;
the `VT_UPLOAD_*` credentials are only validated once an upload actually runs.

### Access

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `HTSM_PIN` | Yes | — | Shared access PIN. Anyone who knows it gets a signed session cookie. Compared in constant time. |
| `HTSM_SESSION_SECRET` | Yes | — | HMAC-SHA256 secret used to sign the session cookie. Use a long random string. |

### Storage

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `HTSM_SCAN_PATH` | No | _(unset)_ | Directory of Illumina run folders to scan. If unset, the startup scan is skipped and the file list stays empty until set. |
| `HTSM_FASTQ_SYMLINK_PATH` | No | _(unset)_ | Absolute destination for the reconciled FASTQ symlink tree. Set to `/mnt/raw/fastq` in production. Requires `HTSM_SCAN_PATH`. |
| `HTSM_DB_PATH` | No | `./hts-manager.db` | Path to the better-sqlite3 database file. |

### FASTQ symlinks for CLC

Set `HTSM_FASTQ_SYMLINK_PATH=/mnt/raw/fastq` to give CLC users a stable view of
the FASTQ files under `HTSM_SCAN_PATH`. An in-process worker reconciles the view
at startup and every 30 seconds. Every direct source directory gets a
destination run directory, even if it has no eligible files.

For NextSeq 500 runs, files directly under `<run>/fastq` are linked into the
destination run directory. For NextSeq 1000 runs, files directly under
`<run>/Analysis/<analysis>/Data/fastq` are linked into the run directory when
there is one analysis; multiple analyses get real `<analysis>` subdirectories.
Only `.fastq.gz` and `.fq.gz` regular files are linked, and every link has an
absolute target.

The destination is managed from source state: stale, broken, and incorrect
symlinks are removed or replaced, while correct links are left untouched. Empty
directories and directories containing only managed symlinks may also be
removed as layouts change. Reconciliation refuses to modify a tree containing
regular files or other unexpected entries, preserving them and logging an
error for the operator to resolve.

### Transfer from sequencer output (work in progress)

hts-manager is being developed to provide automated transfer of completed
Illumina run folders from a sequencer-output directory to `HTSM_SCAN_PATH`, the
central storage directory it scans for sequencing data. Set
`HTSM_TRANSFER_SOURCE_PATH` to the sequencer-output directory to configure the
source. Once implemented, hts-manager will copy whole run folders from there
into `HTSM_SCAN_PATH`, where their FASTQ files can be indexed and made available
for upload.

Source run folders are retained by default. Set
`HTSM_TRANSFER_REMOVE_AFTER_DAYS` to remove a source run after it has been
successfully copied and retained for the configured number of days. For
example, `365` retains source data for one year; `0` allows removal immediately
after a successful copy.

Both directories must already exist, the source must be an absolute path, and
the source and destination must be distinct and not nested inside each other.
Automated discovery, copying, and source removal are not available yet, so
configuring these variables does not currently move or delete files.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `HTSM_TRANSFER_SOURCE_PATH` | No | — | Absolute source directory containing sequencer-side run folders. Setting it enables managed transfer. |
| `HTSM_TRANSFER_REMOVE_AFTER_DAYS` | No | _(unset)_ | Days to retain transferred source files. Unset retains them indefinitely; `0` allows immediate removal after safety checks. |

### Virtool upload target

These are only read when an upload runs. `VT_UPLOAD_USER_HANDLE` and
`VT_UPLOAD_API_KEY` must both be set or the upload throws.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VT_UPLOAD_URL` | No | `https://preview.virtool.ca/api/v1/uploads` | Virtool upload collection endpoint. |
| `VT_UPLOAD_USER_HANDLE` | To upload | — | Virtool username, sent as HTTP Basic auth user. |
| `VT_UPLOAD_API_KEY` | To upload | — | Virtool personal access token, sent as HTTP Basic auth password. |
| `VT_UPLOAD_FILE_TYPE` | No | `reads` | Upload type: `reference`, `reads`, or `subtraction`. |

### Runtime

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `HTSM_SECURE` | No | `true` | Controls the `Secure` flag on the session cookie. Set to `false` only when serving over plain HTTP (e.g. by IP on a trusted, cert-less network) — browsers silently drop `Secure` cookies set over non-HTTPS connections, which otherwise makes the PIN login appear to silently fail. |

## How metadata is derived

Everything is parsed from the **run-folder name + filename** — no file is
decompressed, so scanning is fast.

- A run folder is a **direct child of the scan root** whose name matches the
  Illumina pattern (`230615_A00123_0456_BHGV7DSX3` → date `2023-06-15`,
  instrument `A00123`, run `0456`, flowcell `BHGV7DSX3`). The date must be
  followed by a full instrument/run/flowcell tail; partial names like `230615`
  or `230615_A00123` do not match.
- Lane comes from the filename `_L00N_` token (null for merged outputs).
- Top-level directories that don't match the run-folder pattern are **skipped
  wholesale**, as are files not under a recognized run folder — keep the tree
  conforming. Such files are *not lost*, just not indexed.
- mtime is intentionally ignored: this data has been copied/reorganized, so
  neither filesystem nor gzip-header mtime reflects the actual run date.

## Upload protocol

For each file, hts-manager uses HTTP Basic auth to initialize an upload at
`VT_UPLOAD_URL` with JSON `{ name, type, size }`. Virtool returns a signed
storage URL plus block size and concurrency instructions. The file is streamed
directly to storage in blocks, then hts-manager commits the ordered block list
and finalizes the reservation with Virtool. File bytes never pass through the
Virtool server.

Only one file is processed at a time. If a transfer is interrupted or fails,
hts-manager starts a fresh initialized upload on its next queued retry; signed
URLs are not reused.

## Project status

Feature-complete against [`plan.md`](./plan.md): DB layer, run-folder/filename
parsing, in-process scanner + uploader workers, single-PIN auth, status/file
server functions, and the file-list UI with top-bar indicators. This covers the
original short-lived-tool scope; active development has moved on to the
production-hardening work tracked in [Roadmap](#roadmap).

## Roadmap

Planned as hts-manager grows from a stopgap script into a production service:

- **Active run visibility** — surface in-progress sequencing runs, not just
  completed ones.
- **Automatic handling of done runs** — sequencers write to a target
  directory; hts-manager detects completed runs and copies them to long-term
  storage automatically.
- **Whole-run upload to Virtool** — upload a run's files as a unit, with the
  ability to tag a run for auto-upload before it finishes sequencing.
- **`Undetermined` file exclusion from upload** — excluded by default, with a
  per-run opt-out.
- **Samplesheet parsing** — read samplesheets from run folders when present,
  to enrich run metadata.
