---
name: Reclaim — Plain
version: 2.0
product: Reclaim, an open-source Windows disk analyzer and cleaner (Electron)
summary: >
  A tool that deletes people's files should feel calm and obvious. Plain
  words, familiar Windows controls, one column, and a review step before
  anything changes. Replaces "Marginalia" (v1.1), which users found hard to read.
tokens:
  color:            # light / dark (dark follows Windows app mode unless overridden)
    bg:           ["#F5F6F8", "#16181D"]
    surface:      ["#FFFFFF", "#1F2228"]   # cards
    surface-2:    ["#EEF0F3", "#2A2D34"]   # hover, details rows, empty bar
    border:       ["#DFE2E7", "#353941"]
    text:         ["#1B1D21", "#E8EAED"]
    text-soft:    ["#5D636E", "#A3A9B3"]
    accent:       ["#2A5BD7", "#7AA2FF"]   # primary buttons, links, selection
    danger:       ["#C4321C", "#FF7B68"]   # the final "delete" button and errors only
    ok:           ["#1F7A3D", "#6FCF8E"]   # "Safe" tags, space about to be freed, success
    warn:         ["#7A5000", "#F2C25B"]   # "Check first" tags
  type:
    text: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"   # system font; nothing bundled
    mono: "'Cascadia Mono', Consolas, monospace"                          # file paths in logs only
    scale: [12, 13, 15, 20, 26, 34]
  radius: { card: 8, control: 6, tag: 999 }
  layout: { max-width: 960, gutter: 24 }
---

# Reclaim — Plain

## 1. Principles

1. **Say it in plain words.** "Clean up", "Disk usage", "History", "Safe", "Check first". No symbols that need a legend (§, †, ●◐○), no internal terms ("grade A", "pending", "ledger").
2. **Things that look clickable are clickable.** Buttons look like buttons. A whole row toggles its checkbox. Folders you can open show a `›`.
3. **One column, details next to the item.** A row's explanation opens directly under the row (“Details”), never in a far-away side panel.
4. **Always review first.** Every delete, move and uninstall goes list → review → confirm. The review shows what changes, where it goes, how to undo it, and a total that matches the drive bar.
5. **One next step at a time.** Each list ends in a sticky action bar: what is selected, and one blue primary button. The only red button is the final confirm.

## 2. Layout

- Top bar: app name, six tabs, theme button (Windows / Light / Dark), and a "Demo data" tag outside Electron.
- Page: title, one-line explanation, then cards. Max width 960 px, centered.
- Messages are **notices** (one-line banners) at the top of the page: info (blue), success (green), error (red), warn (amber). Success notices carry their follow-up ("Undo", "View history").
- Lists are tables inside cards. Long lists end in a sticky **action bar**.

## 3. Safety levels

| Tag | Meaning | Selection |
|---|---|---|
| **Safe** (green) | Rebuilt automatically when needed | Pre-selected (if not blocked or slow); "Select safe items" re-selects these |
| **Re-downloads** (blue) | Downloaded or rebuilt the next time it's needed | Never pre-selected |
| **Check first** (amber) | The user's own files | Never pre-selected |

Status tags next to an item: "Needs administrator", "Close chrome.exe first", "Slow", "Didn't finish". Blocked items can't be selected; their Details say why and offer the fix ("Restart as administrator", "check again").

## 4. Screens

- **Clean up** — drive card (free space, bar with used / selected-to-free / free, legend with "Free after cleanup"), notices, cards per section, action bar ("Select safe items", "Clear", "Refresh", "Review and clean up →"). While running: a progress card with the latest line and an optional log.
- **Disk usage** — drive picker + "Choose folder…" + "Scan". Folder table (click a folder to open it, "← Up" and a path to go back), "Show" (Explorer) and "Move…" per row, then Largest files and By file type.
- **Duplicates** — "Where to look" card, then one card per set of identical files with a **Keep** radio and a **Remove** checkbox per copy. The kept copy can't be removed. "Select all extra copies" is an explicit user action; nothing is pre-marked.
- **Programs** — search and sort; each row has "Uninstall…" (opens the review) or "Settings ↗" when no uninstaller is registered.
- **Move folders** — explanation of junctions in one sentence, a two-field form, "Review move →", and a "Moved folders" list with "Show", "Move back" and "Delete old copy".
- **History** — four totals, the activity list newest first with "Undo" / "Move back" / "Delete old copy", export, and a collapsed "How Reclaim keeps your files safe".

## 5. Motion

Small and quick, and never blocking: numbers roll, the drive bar slides, new rows fade in (anime.js). Windows "Animation effects" off (prefers-reduced-motion) turns all motion off. No decorative scenes.

## 6. Writing

- Sentence case. Buttons start with a verb and say the outcome: "Clean up 6.7 GB", "Move 1.7 GB to Recycle Bin", "Delete old copy (2.1 GB)".
- Sizes match File Explorer (base 1024, one decimal from MB up).
- Errors say what happened and what to do next, in one sentence.

## 7. Accessibility

- Native checkboxes, radios, selects and buttons; everything reachable with Tab, Space and Enter. Esc leaves a review and goes up one folder in Disk usage.
- Text contrast at least 4.5:1 in both themes; color is never the only signal (tags carry words).
- Works down to ~720 px wide; the top bar wraps.
