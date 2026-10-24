# Audit — October 2026

Scope: every file in `electron/`, `src/`, `tests/`, the build config and CI. Everything below marked *fixed* is in this commit and covered by a test where it can be tested off-Windows.

## What was already good

- **Architecture.** Clean split between a small, testable engine (`electron/lib`) and the UI. The engine has no Electron imports, so it runs under `node --test` on any OS.
- **Electron security baseline.** `contextIsolation`, `sandbox`, no `nodeIntegration`, a strict CSP, a whitelisted preload bridge, and navigation/window-open locked down.
- **Deletion model.** Cleaners declare roots up front, `assertSafeRoot` rejects protected locations and their ancestors, and `assertInside` fences every single unlink. Links are unlinked, never followed.
- **Move design.** Copy → verify → rename → junction → verify, with rollback and the original kept as `.reclaim-old`. Undo copies the *live* data back.
- **No shell strings** for system tools; uninstall commands are looked up in the main process.
- **UI.** Clear risk labelling, confirmation dialogs, light/dark themes, demo mode for development off Windows.

## Critical (could lose data) — fixed

| # | Where | Problem |
|---|---|---|
| 1 | `mover.finalizeMove` | Only checked that *a* link existed at the source. If the destination drive was unplugged or the junction was repointed, "Delete old copy" would delete the only copy. Now verifies the junction target equals `dest`, that `dest` is reachable, and that the folder is readable through the link. |
| 2 | `duplicates.collect` | Overlapping roots (e.g. `C:\Users\me` and `C:\Users\me\Documents`) listed the same file twice, so it was reported as its own duplicate — and "remove the copy" recycled the only one. Roots are now normalised and paths de-duplicated. |
| 3 | `main.js` `shell:trash` | "Keep at least one copy" was only enforced in the React UI. The main process now remembers the last result and refuses anything not in it, and the last remaining copy of any group. |
| 4 | `mover.planMove` | Folders containing junctions/symlinks were "moved" with robocopy `/XJ`, which skips them; verification ignored them too, so finalize deleted them. Such folders are now refused. Same for folders with unreadable subfolders. |

## High — fixed

- **Concurrency.** A second `clean:run` aborted the running one (e.g. between stopping and restarting Windows Update services); two moves or a move and an undo could interleave; two app instances could do the same. Added exclusive job locks and a single-instance lock.
- **View state lost on tab switch.** Views unmounted on navigation, so a running cleanup/move lost its UI and could be started again. Views now stay mounted after first visit.
- **Restart as administrator** quit the app even if the UAC prompt was declined.
- **`shell:open`** accepted any path from the renderer; on a file it would execute it. Now folders only.
- **Dev flag in release builds.** `RECLAIM_DEV=1` made a packaged build load `http://localhost:5173`. Now gated on `!app.isPackaged`.
- **Electron 31 is end-of-life** with published CVEs; electron-builder 24 pulled in vulnerable `tar`/`app-builder-lib`. Upgraded; `npm audit` is clean.
- **DISM could be killed** mid-operation by Stop. Now runs to completion.
- **OneDrive folders could be moved** behind a junction, which OneDrive treats as deletion. Refused now.
- **Undo** did not check free space on the (usually full) source drive.

## Medium — fixed

- Hard-linked files (WinSxS) counted multiple times in the disk map; hard links reported as duplicates.
- Read-only temp files were always skipped.
- Unquoted `UninstallString`s with spaces failed to launch; MSI `/I` opened the repair dialog instead of uninstalling.
- PowerShell output decoded in the OEM code page garbled non-ASCII names.
- Drilling into a folder while another drill was running cached a partial (aborted) scan.
- Folder picked in the disk map was not shown in the selector.
- `fullHash` added an abort listener per file (listener leak warnings on big searches).
- Recycle Bin "freed" only measured C:.
- Ledger written non-atomically; a crash mid-write lost move history.
- Moves had no progress for multi-GB copies.
- Safety page claimed moves "verify every byte"; they verify file count and total size. Text corrected.

## Not fixed — known limitations

- **No code signing.** SmartScreen will warn. Needs a certificate.
- **Logical sizes.** Node cannot read allocated size on Windows, so cloud-only OneDrive files and compressed folders show full size.
- **Scanner runs in the main process.** Fine for typical drives; a utility process would keep the window smoother on multi-million-file drives.
- **Move verification is count + size**, not content hashes. Robocopy reports failures by exit code, which covers the realistic failure modes; hashing would double the time of a move.
- **Windows-only paths can only be exercised on Windows.** CI runs the full engine suite on `windows-latest` (real robocopy, junctions, hard links, read-only files), but PowerShell/registry/DISM/UAC paths need a manual pass on a real machine before each release — see the checklist below.

## Manual release checklist (Windows)

1. Overview loads drives, hiberfil/pagefile sizes, quick wins.
2. Disk map scans C:, drill into a truncated folder, "Folder…" picker.
3. Cleanup: run User temp + npm cache; Re-measure shows the drop.
4. Restart as administrator: decline UAC (app stays open), accept (elevated copy opens).
5. Move a test folder from C: to another drive, open it through the old path, Delete old copy, then Move back.
6. Duplicates: search Downloads, recycle one copy, confirm it is in the Recycle Bin.
7. Programs: list loads with correct names; Uninstall opens the vendor uninstaller.
