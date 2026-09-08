# AGENTS.md

`CLAUDE.md` is a symlink to this file — edit `AGENTS.md`, not `CLAUDE.md`.

## Project

hts-manager: internal tool to index Illumina sequencing reads (`*.fastq.gz` /
`*.fq.gz`) from run folders and one-click upload them to Virtool. TanStack
Start (React 19, Router + Query), TypeScript, Vite, better-sqlite3, zod,
undici, Tailwind CSS v4 + shadcn/ui. Package manager: pnpm, Node 24.

See [`README.md`](./README.md) for setup/configuration and
[`plan.md`](./plan.md) for original design and rationale.

## Commands

```bash
pnpm dev          # start dev server (http://localhost:3000)
pnpm build        # production build
pnpm start        # run production build (.output/server/index.mjs)
pnpm typecheck    # tsc --noEmit
```

There is no lint or test script configured currently — rely on `pnpm typecheck`.

## TypeScript

- Prefer `type` aliases over `interface` for object shapes, using intersections
  when extending another type.
- Use `interface` only when declaration merging or module augmentation requires
  it.

## Layout

- `src/routes/` — TanStack Router routes/pages.
- `src/functions/` — server functions (e.g. `files.fn.ts`).
- `src/db/` — schema (`schema.ts`) and queries (`queries.ts`), better-sqlite3.
- `src/scan/` — run-folder scanning + filename/run-metadata parsing.
- `src/server/` — server-only setup (auth middleware, uploader worker).
- `src/components/` — React components, `src/components/ui/` for shadcn/ui.
- `example/` — fixture run-folder trees used to exercise `parse.ts`.

## Linear

- Team: `CPH`
- Project: `HTSM`
- Label: `HTSM`

Use this team/project/label combination when creating or updating issues for
this repo.
