# Changelog

## Unreleased

### Interface: simpler design
- New design system "Plain" ([DESIGN.md](DESIGN.md)) replaces Marginalia: system font, cards, real buttons, one centered column, light and dark themes following Windows.
- Plain-language tabs: Clean up, Disk usage, Duplicates, Programs, Move folders, History.
- Safety grades are now word tags (Safe, Re-downloads, Check first) plus status tags (Needs administrator, Close chrome.exe first, Slow).
- Clicking a row toggles its checkbox; "Details" opens the explanation right under the row instead of in a side margin.
- Sticky action bar under every list with the selection total and one primary button; the final confirm is the only red button.
- Disk usage: click a folder to open it, "← Up" to go back, "Show" and "Move…" on each row.
- Duplicates: a Keep radio and Remove checkbox for each copy, and an explicit "Select all extra copies" button.
- Programs: "Uninstall…" on each row; search and sort controls.
- History: totals at the top, newest first, safety rules collapsed under "How Reclaim keeps your files safe".
- Removed: the three.js shred finale, the motion setting (motion now follows Windows "Animation effects"), the bundled fonts, and custom arrow-key row navigation (native Tab/Space/Enter instead).

## 0.1.0 — first public release

### Interface: Marginalia
- New design system ([DESIGN.md](DESIGN.md)): paper/ink tokens, one vermilion signal, rules instead of cards, bundled Newsreader / Atkinson Hyperlegible Next / Commit Mono, light and "carbon paper" dark themes following Windows.
- Text tabs: Overview, Space, Duplicates, Programs, Move, Ledger. Every view has a 7-column sheet with a margin of consequence notes aligned to the selected row (inline under the row below 960 px).
- Drive strip with a hatch for pending bytes replaces the treemap and gauges.
- Safety grades (● A regenerates, ◐ B re-downloadable, ○ C yours, † admin, ✕ locked). Only grade A is pre-selected; grade C is never bulk-selected; cleanups whose app is running are locked and skipped.
- Every destructive flow is Preview → commit, with exact paths, destination, undo and a total that matches the strip.
- Ledger of dated receipts with undo (restore from Recycle Bin, move back), export to .txt/.csv.
- Space fills rows in as each folder finishes, with ghost rules and a live mono log instead of spinners.
- Motion with anime.js (rules draw, rows print, numbers roll, receipts stamp) and a three.js shred finale; full / calm / off, forced off by Windows "Animation effects".
- Full keyboard path: arrows, Space, Ctrl+A (grade A only), Enter, Esc.

### Safety fixes
- Moves: "Delete old copy" now verifies the junction still points at the destination and the destination drive is reachable before deleting anything (previously an unplugged drive could lead to deleting the only copy).
- Moves: folders that contain links/junctions or unreadable subfolders are refused instead of silently losing those entries.
- Moves: OneDrive folders are refused (OneDrive does not sync through junctions).
- Moves: undo checks free space on the original drive before removing the junction.
- Duplicates: overlapping or repeated search folders no longer make a file look like its own duplicate.
- Duplicates: hard links are no longer reported as duplicates.
- Duplicates: "keep at least one copy" is enforced in the main process; only files from the last search can be recycled.
- Only one cleanup or move can run at a time, and only one Reclaim window can be open.
- `shell:open` only opens folders (opening a file would execute it).
- "Restart as administrator" no longer closes the app when the UAC prompt is declined.
- Release builds ignore `RECLAIM_DEV`, so an environment variable cannot make them load `localhost`.
- DISM cleanups can no longer be killed half-way by the Stop button.

### Fixes
- Disk map counts hard-linked files once (WinSxS made C: look much bigger than it is).
- Read-only temp files are now deleted instead of skipped.
- Program uninstall works for unquoted paths with spaces and MSI entries registered with `/I`.
- Program names and drive labels with non-ASCII characters are no longer garbled.
- Recycle Bin cleanup reports the size it freed across all drives.
- Drilling into a folder while another scan is cancelled no longer caches partial results.
- A folder picked with "Folder…" in the disk map is now shown in the drive selector.
- Switching tabs no longer loses a running scan, cleanup log or move progress.
- Cleanup estimates are shared between Overview and Cleanup instead of walking every cache twice.
- Cleaners fall back to `%USERPROFILE%\AppData\Local` if `LOCALAPPDATA` is missing.

### New
- Copy progress for moves and undo.
- Portable `.exe` alongside the installer; app icon; SHA-256 checksums on releases.
- 19 new engine tests (41 total), run on Windows and Linux in CI.

### Dependencies
- Electron 31 (end of life, known CVEs) → 44; electron-builder 24 → 26; Vite 5 → 7. `npm audit` reports 0 vulnerabilities.
