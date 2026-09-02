# @openchamber/opencode-session-lifecycle

This fork owns the OpenCode session-worktree and PTY waiting-status plugins used by OpenChamber. OpenCode Project Manager owns supervision. `agent-config` owns only the host plumbing that installs and loads the plugins.

## Pinned installation

Check out an exact release tag from `jameskorzekwa/openchamber`, then install and build from that checkout. Replace the example tag with the exact published revision you selected:

```bash
git clone --branch v1.21.0-j2k.1 --depth 1 https://github.com/jameskorzekwa/openchamber.git
cd openchamber
bun install --frozen-lockfile
bun run --cwd packages/opencode-session-lifecycle build
```

Add the absolute file URL for the built entrypoint to the `plugin` array in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///absolute/path/to/openchamber/packages/opencode-session-lifecycle/dist/index.js"
  ]
}
```

Restart OpenCode after changing its configuration.

The package version must exactly equal the fork base version. A `j2k` release revision changes the release tag, not this pairing. Every `v1.21.0-j2k.*` release carries plugin package version `1.21.0`. Do not mix the built plugin from one base version with another fork base version.

Retire the `agent-config` overlay copies only after this package lands. Make that retirement in `agent-config`, not in this repository.

## Provenance

The session lifecycle history comes from `agent-config` commits `223d045e92637420c8181aa48b151f219752253d` through `6e80646b4b5bea9407e1bea30ef86bc4ca72f445`. The PTY plugin comes from `cee0627a5113d66dd92441920e4d5b3ed3596def`.
