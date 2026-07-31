# Changelog

Releases are tag pushes: `git tag v1.2.0 && git push origin v1.2.0` publishes a
GitHub release carrying the loadable zip. Versions follow
[semantic versioning](https://semver.org), and the version here, in
`manifest.json` and on the tag are checked against each other before anything
ships.

## Unreleased

Nothing user-facing. Two pieces of upkeep the 1.2.0 release turned up:

- Release notes are now taken from this file's section for the version being
  tagged, rather than a generated list of commit subjects. A tag with no matching
  section falls back to generated notes, so a prerelease does not need an entry
  first, and `validate.mjs` warns when `manifest.json` names a version this file
  has no section for.
- The sign-in bridge is covered by the end-to-end suite: `smoke.mjs` starts a
  local server standing in for a site you are signed into and asserts that the
  frame sees the script-readable token, that the `HttpOnly` session stays out of
  page script, that writes and deletions reach the real jar, and that a sibling
  host is not sent the framed host's cookies. 81 checks, up from 72.

## 1.2.0 - 2026-07-31

### Signed-in sites now work

A framed site is cross-site to the extension page holding it, so the browser
treats it as a third party where cookies are concerned. `document.cookie` reads
back empty inside the frame even when the request cookies arrived intact, so any
app keeping its session token there decides nobody is signed in and redirects to
its login page - and signing in inside the frame appears to do nothing, because
the token it writes goes nowhere either. Testing anything behind a login was
simply not possible.

The **sign-in bridge** carries the reader's real session in. It is the key button
in the toolbar, next to accurate mode, **off by default and remembered per
host**: it hands a site's cookies to a frame the browser had decided to withhold
them from, which is right for a staging site you are testing and not something to
do to every site you preview. The status bar reads `signed in` while it is on.

Two halves, because two different things are broken:

- A `Cookie` request header written by a per-tab `declarativeNetRequest` rule,
  scoped to the tab and the framed host so one site's session can never be handed
  to another. This is the only route that reaches `HttpOnly` server sessions, and
  it survives third-party cookie blocking because the header is rewritten on the
  way out rather than read from a jar the frame is denied.
- A `document.cookie` shim in the framed page, seeded with the cookies a script
  is allowed to see. This is the half that fixes the common case, a single-page
  app reading a token. Reads merge in whatever the real store returns, so a frame
  that can see its own cookies is never made worse off. Writes are relayed back
  and written to the real jar, which is what makes a sign-in performed inside the
  viewer outlast the tab, in the viewer and in a normal tab alike.

`HttpOnly` cookies are never seeded into the shim. They ride the header,
invisible to page script, exactly as in a normal tab.

It cannot complete an OAuth or SSO flow - those need a top-level navigation or a
popup, which a sandboxed frame will not do - so sign in normally first and let
the bridge carry the result. A cookie session served from a host the frame has
not visited yet is likewise only bridged once it goes there, since the rule
follows the frame's host.

### Also

- The manifest asks for the `cookies` permission, which the bridge needs to read
  the jar and write back to it. Nothing reads cookies unless the bridge is on for
  that host.
- Cookie serialisation and `Set-Cookie` parsing live in `src/lib/cookies.js` and
  are unit tested, including the case that matters most: a script signs out by
  re-setting a cookie as already expired, and a bridge taking that for a write
  would put the session straight back.
- Device rules and the bridge rule no longer share rule ids, so switching device
  inside a viewer no longer tears the bridge down.
- Verified end to end against a server behaving like a cookie-session site: the
  header carries `HttpOnly` cookies, `document.cookie` sees only the
  script-visible ones, and writes and deletions inside the frame reach the real
  jar.

## 1.1.0 - 2026-07-31

- **Right-click any page or link to open it on a device.** "Open in Gonbi
  Viewport" carries a submenu built from what the popup already knows: the device
  you used last, favourites and recents, then saved comparison sets. A link wins
  over the page it sits on, a nested iframe does not hijack the target, and
  inside a viewer it resolves to the site being framed rather than the viewer's
  own address - which makes the menu the shortest way to move a page onto another
  device.
- **Loads no longer wait on the extension.** The scroll-position question now
  runs alongside arming the tab and gives up after 400ms instead of 2000ms,
  session state is read once per worker rather than per message, and an identical
  set of header rules is no longer re-installed. On a busy page, click to first
  request went from 2032ms to 426ms.
- **The wearable category is gone**, along with the platform, browser list and
  frame-generator branches that existed only to support one watch nobody was
  testing against. 60 devices, 56 KB of frames, no orphan artwork.

## 1.0.0 - 2026-07-30

First release.

- 60 phone, tablet, laptop, desktop and TV viewports, each with a generated SVG
  frame whose screen is a real cutout, so the page shows through while the bezel
  and notch stay drawn on top.
- Fuzzy device search in the popup: `ip15p` finds the iPhone 15 Pro.
- Framing and device detection handled with session `declarativeNetRequest` rules
  scoped to a single tab id, so header relaxation only ever applies inside a
  viewer tab you opened deliberately.
- Simulated device UI - status bar, home indicator, browser toolbar - so the
  reported viewport is what a page really gets, toggleable with `U`.
- Comparison mode for up to six devices side by side, with synced scrolling that
  also follows inner scroll containers.
- Responsive and accessibility audit: horizontal overflow, tap targets, text
  size, contrast, missing alt text, unlabelled fields and restricted zoom, plus a
  sweep across every breakpoint the page declares.
- Breakpoint strip read from the page's own stylesheets, with chips that snap the
  viewport to each one.
- Screenshots, stitched full-page capture and WebM recording.
- Accurate mode over `chrome.debugger`: real device pixel ratio,
  `prefers-color-scheme`, `prefers-reduced-motion`, `forced-colors`, vision
  deficiencies, network throttling, and locale, time zone and geolocation.
- Custom viewport sizes by dragging the frame's corner or typing them.
