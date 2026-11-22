# Validated release installation

## Ownership

This module owns the fork's validated GitHub release channel, bounded archive
download and extraction, durable release selection, restart journals, process
attestation and rollback. `../self-update` owns the HTTP routes. The CLI startup
module owns managed-launcher and systemd configuration.

`validated-release-installer.ts` owns channel metadata, installation state and
the ordered install/rollback transaction. `release-artifact.ts` owns bounded
HTTP reads, redirect validation, tar validation/extraction, dependency checks,
durable filesystem operations and the rollback archive. `release-contract.ts`
owns the release metadata shapes and shared value guards. The installer keeps
its public exports, including the durable-directory helper.

## Invariants

- A release must match its channel metadata, GitHub tag commit, upstream
  ancestry, exact asset inventory, runtime target and checksum before selection.
  Extraction rejects traversal, links, unsupported tar metadata and resource
  limits. Production dependencies must be bundled inside the release.
- Packages contain `build/bin/cli.js`, `build/server/index.js`, the stable
  compatibility launcher `bin/cli.js`, and the UI entry.
  Package discovery follows the owning manifest so source and emitted modules
  resolve the same install root.
- The previous release remains recoverable. Durable journal preparation precedes
  service migration and release selection; authenticated health verification
  precedes marking an update installed.
- Helpers bind ownership and cleanup to the transaction ID. Lock leases,
  termination capabilities and authenticated process identities prevent stale
  helpers from terminating a replacement process or deleting a newer journal.
- Persisted status supersedes in-memory availability only when its timestamp
  changes. An unchanged terminal record must not erase a fresh channel check.
- Web servers update through this validated channel. Desktop hosts retain their
  native updater, and externally managed hosts can disable in-app installation.
  Windows and unmanaged foreground processes retain the unsupported response.

## Decisions

### Why helper launch arguments depend on the installed layout

Detached Node processes do not inherit an in-process source resolver. Checkout
helpers explicitly preload `register-server-sources.mjs` and run the typed entry.
Installed helpers run emitted JavaScript directly and need no checkout files.
The focused tests execute both layouts in plain Node without `NODE_OPTIONS`.

### Why JSON parsing retains values until validation

JSON decoding yields JSON values; channel, state and attestation checks establish
the domain contracts. Filesystem identity checks remain separate from structural
validation so a typed journal cannot bypass canonical paths or release identity.
The local `proper-lockfile` declaration describes the installed dependency's
promise-based lock and release API without adding a runtime dependency.

### Why ancestry checks request the second comparison page

GitHub's comparison response retains ancestry fields on later pages while the
first page also includes file patches. Requesting page 2 bounds the response
without discarding the merge-base evidence.

### Why an older channel can report no validated release

A newly installed runtime can still see the preceding stable channel targeting
another ABI. An older channel is absence of an applicable update; malformed
metadata or a newer incompatible target remains an error.
