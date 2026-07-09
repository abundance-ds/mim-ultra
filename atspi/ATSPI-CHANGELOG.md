# atspi-tool changelog

Iterative optimization log. Each entry: what changed, why, measured impact.

---

## 2026-07-09 — v4: robust D-Bus discovery for Surf/WebKit

### Problem
The desktop could be visible in VNC with Surf showing Reddit login, but `atspi read surf` returned only:

```text
[application] "surf"
  [frame] "... | Welcome to Reddit"
```

`/usr/local/bin/atspi` read the session bus address only from `/tmp/desktop.log`. When that log was missing, the wrapper exported `DBUS_SESSION_BUS_ADDRESS=""`. Apps launched through `atspi open`, including Surf and its WebKitWebProcess children, inherited the empty bus address and did not publish the web document tree to AT-SPI.

### Changes
- `atspi-wrapper.sh` now resolves the desktop D-Bus address from `/tmp/mim-desktop.env`, `/tmp/desktop.log`, the running desktop process environment (`bspwm`, `xfsettingsd`, `sxhkd`, `at-spi2-registryd`), the existing environment, or `/run/user/$UID/bus`.
- `start-desktop.sh` writes `/tmp/mim-desktop.env` after `dbus-launch`.
- `atspi interact` now walks deeper through WebKit trees and preserves editable `embedded` controls, so Reddit login fields appear in the flat interaction list.

### Check
- Reinstalled `/usr/local/bin/atspi` in the container.
- Recompiled and reinstalled `/opt/atspi-tool` in the container.
- Fresh `atspi open "surf https://www.reddit.com/login"` produced a readable tree containing Reddit's login dialog, username/email field, password field, and login button.
- `atspi interact surf` now includes `Email or username` and `Password`.
- The launched Surf process now has the desktop session bus address in its environment.

## 2026-07-08 — v3: bspwm focus/close compatibility

### Problem
The bspwm desktop swap exposed a bad assumption in `atspi focus` and `atspi close`: both searched X window titles only. GNOME Calculator appears to AT-SPI as `gnome-calculator`, but its X title is `Calculator` and its WM_CLASS is `gnome-calculator`. `atspi close gnome-calculator` could report success while leaving the window alive if it did not activate the right X window first.

### Changes
- `atspi focus <app>` now searches both X window title and WM_CLASS.
- `atspi close <app>` now searches both X window title and WM_CLASS, chooses the newest match, activates it, waits briefly, then sends `WM_DELETE`.
- Shell arguments are single-quoted safely before use in the xdotool search command.

### Check
- Manual test: `atspi focus gnome-calculator` and `atspi close gnome-calculator` work under bspwm.
- Manual trace launched Calculator, saw it in `atspi apps`, closed it, and a follow-up process/app check showed it gone.

## 2026-07-08 — v2: interact command + aggressive filtering

### Problem
`atspi read surf` on a Reddit page returned 1185 lines. The agent burned context parsing hundreds of unnamed `[page]` nodes, duplicate viewport variants, broken `￼` (U+FFFC) placeholders, and misclassified roles (`[math fraction]` for timestamps, `[footer]` for comments). In a browsing session, the agent hallucinated a cookie banner reappearing — likely confused by noise in the tree output.

### Changes

**New `interact <app>` command**
- Walks the tree, emits ONLY elements that have an action interface (clickable) or editable state AND a non-empty, non-junk name.
- Flat list grouped by role — no tree indentation, no depth.
- Global dedup: skips if name is substring of (or contains) any previously added name. Kills `"List item post - X"` / `"r/Sub - X"` duplicates from Reddit's multiple accessible-name mappings.
- Skips structurally noisy roles entirely: `math fraction`, `definition`, `unknown`, `list item`, `document text`, `document frame`, `audio`, `image`.
- Skips `Advertisement:` prefixed names.
- Names truncated at 100 chars.

**Improved `read` filtering**
- Expanded unnamed-skip list: now also skips unnamed `page`, `section`, `article`, `list`, `list item`, `document text`, `document frame`, `embedded`, `footer`, `header`, `form`, `math fraction`. These map to structural web divs/spans — noise without a name.
- Strip U+FFFC (object replacement char) and U+2022 (bullet) from text values instead of showing garbage.
- Trim leading/trailing whitespace from text values.
- Truncate names >80 chars and text >120 chars with `...`

### Measured impact (Reddit post page in surf)
| Metric | Before | After |
|--------|--------|-------|
| `read` lines | 1185 | 537 |
| `interact` elements | n/a | 98 |
| Bare `[page]` nodes in `read` | 377 | ~0 (unnamed ones skipped) |
| Broken `￼` text entries | 36 | 0 |

### What still needs work
- `read` is still 537 lines — could benefit from collapsing single-child chains
- `interact` shows 98 elements for one Reddit page — consider adding a `--limit N` flag
- No scroll position indicator — agent can't tell what's visible vs offscreen
- `snap` diff is still noisy on full page loads (every line changes)
- Native GTK apps have cleaner trees already; most noise is from WebKit's a11y mapping
