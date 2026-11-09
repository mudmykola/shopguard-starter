# Dev Log

## 2026-11-05 — Feature

Implemented the single-epic private ShopGuard MVP: root-level TypeScript CLI, guarded initialization and setup, explicit store configuration, diagnostics, dry-run development, isolated pull snapshots, sync and preflight checks, protected-file detection, fail-closed push guards, offline tests, CI, and Keeper/GitHub security guidance.

Module: CLI/core. Issue: local backlog, Phase 1–5 epic.

## 2026-11-09 — Improvement

Switched the documented private GitHub workflow to HTTPS per owner direction. Keeper SSH Agent is optional and no longer a setup requirement. Module: GitHub access. Issue: #1.

## 2026-11-09 — Feature

Implemented config-driven existing/new theme bootstrap, isolated downloads, reviewed additive imports, private per-client config, local master/dev baseline, guarded development upload, HTTPS Git fetch/fast-forward, selective pull snapshots, changed-file format selection, local/remote protected JSON preflight, and CI lint coverage. Added 30 offline tests. No real store, GitHub remote, or publishing action was run. Module: CLI/core. Issue: #1.

## 2026-11-09 — Feature

Implemented manual push to an explicitly configured unpublished, non-GitHub-connected theme: operator-confirmed baseline snapshots, selected-file-only upload, protected JSON/deletion exclusion, per-file remote drift checks, immediate recheck before upload, Shopify Theme Check, `--nodelete`, post-upload pull verification and retained recovery snapshots. Added offline tests for success, Live refusal, protected files, declined confirmation, remote drift and verification boundaries. Full validation passes: 35 offline tests, typecheck, ESLint, build, package dry-run. No real Shopify upload was executed. Issue #1 complete; Project #6 set to Done. Module: CLI/push. Issue: #1.

## 2026-11-09 10:38 — Improvement

Title: Shopify theme code-quality workflow in README. Reworked setup and day-to-day commands, distinguished CLI package checks from storefront Theme Check, documented Liquid, performance, accessibility and merchant-data practices, and added prioritized VS Code, CI, pre-commit, browser-test and performance-tool recommendations. Module: Documentation/README. Issue: #2.

## 2026-11-09 11:25 — Feature

Title: One-command Shopify theme developer workflow. `sgd setup` now adds missing quality configuration, VS Code defaults and a client Theme Check workflow without replacing existing files; it detects the repository package manager and asks before dependency installation. Added reversible pre-commit hooks, actionable `status`/`doctor` diagnostics, Ukrainian setup/store errors, and read-only opt-in Playwright + axe preview checks for semantics, keyboard focus, responsive overflow and WCAG. Updated CI, README and offline coverage. Validation: `npm run check` passes (39 unit tests); three E2E tests are skipped because no preview URL was configured. No Shopify store or remote Git action was run. Module: CLI/core. Issue: #3.

## 2026-11-09 11:58 — Improvement

Title: README rewritten in Ukrainian. Replaced the English guide with a step-by-step explanation of creating a private client repository, configuring and initializing a store project, running daily checks, using optional hooks and browser tests, and understanding Shopify/Git safety boundaries. Verified commands against `src/cli.ts`; `git diff --check` passes. No store, Git remote, commit, or package publishing action was performed. Module: Documentation/README. Issue: #4.

## 2026-11-09 13:47 — Fix

Title: Keep Shopify development preview running and document the GitHub release flow. `sgd dev` now starts Shopify CLI as a long-running child with inherited terminal output, no generic timeout, and clean Ctrl+C handling. README documents `feature/*` → PR to `dev` → connected unpublished theme review → PR to `master` → connected published Live theme, including the immediate production effect of merging to `master` and Shopify's two-way GitHub sync. Added offline process tests. Validation: `npm run check` passes (41 unit tests); three opt-in browser tests skip without a preview URL; `git diff --check` passes. No Shopify store or Git remote was accessed. Module: CLI/README. Issue: #5.

## 2026-11-09 15:17 — Improvement

Title: Choose a Shopify source theme and keep it separate from upload targets. `sgd init` now lists available themes and requires a Live or unpublished source selection (interactive ID prompt or `--source-theme <id>`), then requests a second typed confirmation before local-only download. Development themes are excluded. The actual Live ID is still recorded independently; selecting a source does not alter `themeId`. README now explains source selection, Live-write safeguards, and the GitHub `master` branch protection boundary. Validation: `npm run check` passes (44 unit tests); three opt-in browser tests skip without a preview URL; `git diff --check` passes. No Shopify store, theme connection, Git remote, or package publishing action was run. Module: CLI/README. Issue: #6.
