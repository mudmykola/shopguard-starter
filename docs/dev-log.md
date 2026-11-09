# Dev Log

## 2026-11-05 — Feature

Implemented the single-epic private ShopGuard MVP: root-level TypeScript CLI, guarded initialization and setup, explicit store configuration, diagnostics, dry-run development, isolated pull snapshots, sync and preflight checks, protected-file detection, fail-closed push guards, offline tests, CI, and Keeper/GitHub security guidance.

Module: CLI/core. Issue: local backlog, Phase 1–5 epic.

## 2026-11-09 — Improvement

Switched the documented private GitHub workflow to HTTPS per owner direction. Keeper SSH Agent is optional and no longer a setup requirement. Module: GitHub access. Issue: #1.

## 2026-11-09 — Feature

Implemented config-driven existing/new theme bootstrap, isolated downloads, reviewed additive imports, private per-client config, local master/dev baseline, guarded development upload, HTTPS Git fetch/fast-forward, selective pull snapshots, changed-file format selection, local/remote protected JSON preflight, and CI lint coverage. Added 30 offline tests. No real store, GitHub remote, or publishing action was run. Issue #1 remains In Progress: manual staging push is fail-closed until fresh role, drift, recovery and post-upload verification exist. Module: CLI/core. Issue: #1.
