# V2 M1 Character Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver persistent character identities, appearance versions, upload/generated portraits, approved asset manifests and stable shot references without claiming reference-conditioned video before M2.

**Architecture:** Extend the current SQLite repository with a focused character store using the same connection and atomic transactions. Expose an application service for bounded image decoding and durable portrait jobs. Pi remains a proposal-only planner. React edits the character library and stable shot bindings. Existing V1 projects retain their workflow; V2 generation is explicitly blocked until M2.

**Tech Stack:** TypeScript, Zod, node:sqlite, Fastify, React, Pi SDK, OpenRouter, FFmpeg; a maintained image decoder for actual type/size/animation validation. Tests: Vitest and full-browser Playwright.

**Execution:** Sequential checkpoints in `codex/v2-character-library`, isolated checkout `../story-agent-v2`. No paid requests as part of automated tests. No push.

## Shared contracts and file map

- Create `src/domain/characters.ts`: character, look, immutable look version, image asset, portrait job and library schemas/types; mention candidates/resolution and input validation.
- Create `src/storage/characters.ts`: project-scoped SQLite store sharing the repository connection; CAS library revision, approvals, references and portrait job records.
- Modify `src/domain/storyboard.ts`, `src/storage/repository.ts`: optional workflowVersion=2, shot `characterRefs`; legacy JSON compatibility, V2 validation and explicit upgrade. Back up an existing database before the additive schema migration.
- Create `src/characters/service.ts`, `src/characters/images.ts`: actual image validation/storage, deterministic portrait prompts, paid submission lifecycle, preview/impact handling.
- Modify `src/media/openrouter.ts`: portrait generation uses the existing cloud image submission/error contract, with square portrait parameters and no video behavior changes.
- Modify `src/director/pi-director.ts`, `src/workflow/workflow.ts`: optional registered-role context; preserve returned IDs, seed role drafts after first plan; do not let replanning silently replace registered identities. V2 paid video blocked server-side.
- Create `src/server/characters.ts`; modify `src/server/app.ts`, `src/server/main.ts`: scoped routes and dependency assembly. Binary upload is isolated from normal JSON limits. Asset responses omit local paths.
- Create `src/client/Characters.tsx`, `src/client/CharacterReferences.tsx`; modify `src/client/App.tsx`, `src/client/styles.css`: role editor, candidate references, upload/portrait controls, invalidation/impact feedback and V1/V2 labels.

Stable shot reference shape:

```ts
type CharacterRef = { characterId: string; lookId: string; lookVersionId: string };
```

The database is the authority: ownership, version existence and selected-version compatibility are checked on save/approval. Display names and aliases resolve to stable IDs; email text is not a mention. Unknown or ambiguous mentions prevent approval. Plain-role references with multiple looks require an explicit default or user choice. Empty-role stories remain valid.

## Task 1 — Domain, persistence and reference invariants

- [x] Add `tests/characters-store.test.ts` and `tests/character-references.test.ts` with real SQLite reopen and assertions such as:

```ts
expect(reopened.snapshot(projectId).characters[0].id).toBe(character.id);
expect(() => store.rename(projectId, staleRevision, character.id, '陈伯')).toThrow(/版本/);
expect(() => store.deleteCharacter(projectId, revision, referencedId)).toThrow(/引用/);
```

- [x] Run `npm.cmd test -- tests/characters-store.test.ts tests/character-references.test.ts`; observe missing-feature failures before implementation.
- [x] Implement scoped identities, aliases, look drafts/versions and primary image selection, revisions, visual manifest hashing, rename-safe references, deletion guards, affected-shot lookup and empty-role approval. A name-only rename preserves visual approval; changed appearance/image/style invalidates it. Old images and versions are immutable.
- [x] Add tests for cross-project references, duplicate names/aliases, stale versions, wrong look ownership, 21 shots, migration backup, restart and input edits during active work. Run these tests and existing domain tests; all must pass before Task 2.
- [x] Commit domain/store checkpoint.

## Task 2 — Portrait images and durable generation

- [x] Add `tests/character-media.test.ts`: use genuine PNG/JPEG/WebP buffers; assert corrupt, animated, MIME-disguised, >10 MiB and >4096-pixel inputs fail. Prove only one provider call after double-click, uncertain submission and restart. Simulate failure after provider success to prevent duplicate billing.
- [x] Run the new suite and observe the specific missing-image/job behavior fail.
- [x] Implement strict decoding and bounded local storage; persist SHA-256, size, MIME, dimensions, origin and simulated flag. Use server-generated paths and DB asset IDs. Never accept caller paths or arbitrary URL fetches.
- [x] Portrait generation compiles identity + look + global style into a single-subject, simple-background prompt. User explicitly requests a generation for an exact library revision. Candidate output becomes a new appearance version only after validation; it is not automatically approved. Unknown submission blocks further attempts for that look until resolved; startup converts interrupted real POST jobs to unknown. Test fixtures remain visibly simulated.
- [x] Verify cloud request shape via injected fetch (no network), cumulative unit tests and typecheck; commit checkpoint before Task 3.

## Task 3 — API, Pi planning and workflow boundary

- [x] Add `tests/character-api.test.ts`, extend director/workflow tests before production changes. Assert upload preview path isolation, stale CAS conflict, edit impact, role confirmation, draft-image cost acknowledgement, V2 video blocked without media calls, explicit legacy upgrade, no model-created asset approval, and registered-ID preservation on replan.
- [x] Run targeted suites and observe failures.
- [x] Implement library GET/mutations/approval, bounded binary upload, generated portrait request/estimate and asset read endpoints. Fastify same-origin checks apply equally. Validate route IDs, request shapes and project ownership; return static sanitized errors.
- [x] New production projects default V2; Repository internal default and explicitly requested V1 retain compatibility. Demo initially retains V1 so existing playback tests remain meaningful. `enable-v2` clears obsolete approval but retains outputs. Creation/upgrade cannot start paid tasks.
- [x] Pi receives only project-relevant role IDs, names, descriptions and looks. It returns drafts, never generates images or approves assets. First plan may create role drafts; replan uses existing identities and rejects unsupported identities rather than silently rebinding. V2 references remain editable drafts until all used looks have an image and a valid role manifest.
- [x] Run cumulative unit tests plus build; commit checkpoint before Task 4.

## Task 4 — Character UI and shot references

- [x] Add a Playwright V2 case before UI changes: select V2, plan, edit role/aliases, add young/elder appearances, upload portrait, approve, bind a shot candidate by typing `@`, save/reload, rename role while retaining binding, replace image and observe approval invalidation. Confirm V2 video button explains M2 dependency; legacy playback still passes.
- [x] Run the new browser case and observe expected missing UI failure.
- [x] Build focused components with labelled fields, immutable history selection, image preview and impacted-shot summary. Use stable IDs in React and stored refs. Reference autocomplete exposes role and appearance; unknown pasted references are actionable errors. Selecting a new project clears unsaved local state; polling must not overwrite active edits.
- [x] Add only styling needed for usable desktop/mobile layouts. Production defaults V2; label legacy projects. AI portrait controls show provider/estimate and user-triggered spending; role confirmation is separate.
- [x] Run browser tests, unit tests, typecheck and production build. Fix regressions before delivery.

## Task 5 — Review, documentation and integration handoff

- [x] Review against each M1 requirement; correct spec or implementation disagreements explicitly. Obtain independent spec and code-quality reviews using the requesting-code-review skill; repair actionable findings and re-run affected tests.
- [x] Record exact red/green and final results in `docs/delivery.md`; update README with M1 capabilities, V2 limitations and API-only generation boundaries. Do not claim visual consistency gains or paid API acceptance without measurements.
- [x] Verify staged files contain no secrets/local data; `git diff --check` and full `npm.cmd run verify` must pass. Restore unrelated auto-generated V1 screenshots.
- [x] Deliver M1 for local use with a safe merge into the original checkout, keep `.env.local` and database in place, and restart the local service only after successful verification. M2 begins after the M1 test checkpoint; never skip the sequential gate. Ask before pushing the completed major version.

## Plan self-review

M1 coverage: roles/looks/aliases, immutable references, both image sources, actual file validation, manifest invalidation, stable mentions, registered-ID planning, migration, paid-job recovery, V1 preservation and V2 generation block each have an explicit test and implementation task. M2/M3 are intentionally outside this plan; this avoids coupling role delivery to paid video acceptance. Human authorization already covers execution; proceed sequentially without another execution-choice question.
