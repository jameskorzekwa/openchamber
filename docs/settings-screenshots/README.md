# OPM settings visual evidence

Captured on 2026-09-14 in the laptop's existing Chrome, rendering the actual
`OpmSettingsPanel` and theme provider against an isolated OPM runtime, SQLite
store, and configuration. No production settings were changed.

| State | Wide pane | Narrow pane |
|---|---|---|
| Light | [900px](wide-light.png) | [390px](narrow-light.png) |
| Dark | [900px](wide-dark.png) | [390px](narrow-dark.png) |

Interaction evidence:

- [Applied](applied.png): enabled **Admit new work**, saved through the real
  control handler, and observed `effective.projects[0].enabled: true` while
  `effective.paused` remained `true`.
- [Rejected](validation-error.png): entered `pollSeconds: 0`, saved, and
  observed the inline validation error. GET still reported the working value
  `pollSeconds: 20` and admission remained enabled. The invalid draft stayed
  in the editor.

The baseline has no settings editor, so there is no corresponding before
pane. These PNGs are browser DOM rasterizations using the already-installed
`html-to-image` package, not native screen recordings. Sprite symbols were
inlined from the actual icon sprite during capture. Playwright's extension
was unavailable and macOS refused native window capture. AppleScript drove
only the disposable preview window, which was closed afterward. No animation
or gesture behavior is changed by this feature.
