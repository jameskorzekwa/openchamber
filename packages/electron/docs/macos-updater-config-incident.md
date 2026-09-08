# macOS updater configuration incident

This record covers the shipped `1.21.0-j2k.22` and `1.21.0-j2k.24` macOS
desktop releases. It identifies the first stage where
`Contents/Resources/app-update.yml` was absent. It does not select another
packaging fix or change release publication.

## Conclusion

The updater configuration was already absent at the end of unsigned candidate
generation for `1.21.0-j2k.22`. The `candidate-build` job called the real
packaging entry point with `--mac --arm64 --dir --publish=never`.
electron-builder 26.8.1 did not write `app-update.yml` because the macOS target
set contained only `dir`. The source revision's `afterPack` hook copied
`Assets.car` but did not write an updater file.

The next job transferred that exact app, signed it, then called the same
`package.mjs` entry point with `--prepackaged` to create the ZIP and DMG.
Prepackaged target creation does not repack the app or run `afterPack`, so it
did not add the updater file. Signing does not create `app-update.yml` either.
Both shipped `.22` packages consequently lack the file.

`--publish=never` did not suppress the updater configuration. In
app-builder-lib 26.8.1, `PublishManager` registers an `onAfterPack` writer even
when publishing is disabled. On macOS, that handler returns before resolving
the publish configuration or writing the file unless the targets include
`dmg` or `zip`. The actual `.22` target was only `dir`. A local reproduction
through `package.mjs` reaches the same state with the historical hook. The
`.24` package also shows that `--publish=never` can produce a valid file when
the candidate's own `afterPack` hook writes it.

The `.24` source added that write to `after-pack.cjs`. Its unsigned candidate
therefore acquired the J2K updater file before transfer, and the prepackaged
ZIP and DMG retained it. This investigation leaves that existing production
behavior unchanged.

## Shipped release evidence

Both releases are macOS arm64 builds with Electron `43.3.0` and OpenCode
`1.18.23`. The release metadata records hardened runtime as enabled, the
private self-signed certificate fingerprint
`AF454592FBE5229928CDEAF64850AC5F4DA1CFCFE9B2FCBFBAD97956F2CBB997`,
and notarization and stapling as disabled.

### 1.21.0-j2k.22

- Desktop release:
  <https://github.com/jameskorzekwa/openchamber/releases/tag/desktop-v1.21.0-j2k.22>
- Companion web release:
  <https://github.com/jameskorzekwa/openchamber/releases/tag/v1.21.0-j2k.22>
- Published: `2026-09-08T17:58:59Z`
- Source revision: `49e52eec69fa8bc7a9e195ac43fce03d23505a38`
- Desktop tag object: `667a2796dfcb7351b3c5b2cacbd1ff89e5e733e0`
- Web tag object: `47d79da577253c38ae264904fc29f82b3b2dcddd`

Tag-scoped assets use
`https://github.com/jameskorzekwa/openchamber/releases/download/desktop-v1.21.0-j2k.22/<asset>`.

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `OpenChamber-1.21.0-j2k.22-mac-arm64.dmg` | 212999180 | `6907040debe19839c8c71db1d3b6097fed8a2dc5b08dd2f74b80cb58f3abf622` |
| `OpenChamber-1.21.0-j2k.22-mac-arm64.zip` | 205977080 | `e498ed8c662ccddd1f804aa5b6cbc984f0c607418fd2dee1afe755fb77a4d4dc` |
| `OpenChamber-1.21.0-j2k.22-mac-arm64.zip.blockmap` | 217954 | `2d25149162983289ebe8d9a30e543cd8e1aff656e5ec723f42aace8f4cca0a14` |
| `latest-mac.yml` | 555 | `1a1160db28f59df4aecdf5a79d427287f32f30dca052cea6397a561d21229ab5` |
| `SHA256SUMS` | 408 | `624152519b3cb98a988276afd81487cdb1aca13534c5369088ff5ce55bcd73ae` |
| `desktop-release.json` | 1186 | `ee510ac23bce3d7642d9b3610221d89039dbbaf1664221d18b8b5a725893b6fc` |

The downloaded ZIP and DMG matched both `SHA256SUMS` and the hashes in
`desktop-release.json` before inspection. The ZIP-extracted signed app and the
signed app in the read-only mounted DMG both lack `app-update.yml`.
`codesign --verify --deep --strict` succeeded for both app bundles.

### 1.21.0-j2k.24

- Desktop release:
  <https://github.com/jameskorzekwa/openchamber/releases/tag/desktop-v1.21.0-j2k.24>
- Companion web release:
  <https://github.com/jameskorzekwa/openchamber/releases/tag/v1.21.0-j2k.24>
- Published: `2026-09-08T19:13:01Z`
- Source revision: `5b53d2af16224d834d64794610337c0501b1eb31`
- Desktop tag object: `5d9728d947b63ac23cdb51818afdd42023ec168a`
- Web tag object: `97d93654c957e5a55936dd758fc1528ceeae2785`

Tag-scoped assets use
`https://github.com/jameskorzekwa/openchamber/releases/download/desktop-v1.21.0-j2k.24/<asset>`.

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `OpenChamber-1.21.0-j2k.24-mac-arm64.dmg` | 213012323 | `77b3f1df1de35ce545c507f470d82c8333badacc836745189a9a5bf525f6ece2` |
| `OpenChamber-1.21.0-j2k.24-mac-arm64.zip` | 205989863 | `07388af1ab6a53cd3b2f8bba107af3dc53bbcbbfc63fe57bcc192e70ecd7566b` |
| `OpenChamber-1.21.0-j2k.24-mac-arm64.zip.blockmap` | 217243 | `5d33496b66c2aa20202edae65b27f7add72d5e9570215ab67b9eaec33644b916` |
| `latest-mac.yml` | 555 | `2dc08c33b64372ca460c14b3506f15776835a4481c1f65098bda4970ffbb2a1c` |
| `SHA256SUMS` | 408 | `2eed673ee866e60cda108da04106477cb37b47cb4e5e7580902ce0afcefff2e1` |
| `desktop-release.json` | 1186 | `50570e7fb043cc60d2de560d38666fc693df5c28989666c9e552b125bedcd2ec` |

The downloaded ZIP and DMG matched both checksum sources before inspection.
Both signed apps contain the same 143-byte `app-update.yml`, with SHA-256
`6b79cfa6b2e31b479f5009adad5805308f0351a4a90deb5f93842631d2018f58`:

```yaml
provider: generic
url: 'https://raw.githubusercontent.com/jameskorzekwa/openchamber/desktop-channel/'
updaterCacheDirName: openchamber-updater
```

The provider URL matches the J2K `desktop-channel` feed documented in this
package. `codesign --verify --deep --strict` succeeded for both app bundles.

## Workflow provenance

The release workflow and `package.mjs` are identical between the two source
revisions. The relevant source difference is the candidate's `afterPack` hook.

For `.22`, J2K Release run
[`34259100609`](https://github.com/jameskorzekwa/openchamber/actions/runs/34259100609)
was run 110 and succeeded.

| Job ID | Job name |
|---:|---|
| `102172267762` | `metadata` |
| `102172416594` | `validate-release` |
| `102172417220` | `build-desktop / metadata` |
| `102172534404` | `build-desktop / candidate-build` |
| `102174799517` | `build-desktop / sign-and-verify` |
| `102176001819` | `publish` |

Its upstream validation was run
[`34258574098`](https://github.com/jameskorzekwa/openchamber/actions/runs/34258574098),
run 107. Job `102170502805`, `Typecheck, lint, test, build, and smoke`,
succeeded.

For `.24`, J2K Release run
[`34266343062`](https://github.com/jameskorzekwa/openchamber/actions/runs/34266343062)
was run 116 and succeeded.

| Job ID | Job name |
|---:|---|
| `102196565884` | `metadata` |
| `102196732397` | `validate-release` |
| `102196733330` | `build-desktop / metadata` |
| `102196850259` | `build-desktop / candidate-build` |
| `102199085615` | `build-desktop / sign-and-verify` |
| `102200548449` | `publish` |

Its upstream validation was run
[`34265733724`](https://github.com/jameskorzekwa/openchamber/actions/runs/34265733724),
run 113. Job `102194496499`, `Typecheck, lint, test, build, and smoke`,
succeeded.

## Packaging-path reproduction

The bounded reproduction used the repository's installed Electron 43.3.0 and
electron-builder 26.8.1 on a native macOS arm64 host. A temporary builder
configuration selected the `.22` `after-pack.cjs`, disabled identity discovery
and notarization, and sent all output to a temporary directory. It then ran:

```bash
OPENCHAMBER_J2K_DESKTOP_BUILD=1 OPENCHAMBER_TARGET_ARCH=arm64 \
CSC_IDENTITY_AUTO_DISCOVERY=false node ./scripts/package.mjs \
  --mac --arm64 --dir --publish=never --config <candidate-config.json>
```

`app-update.yml` was absent after unsigned app generation and after the
historical `afterPack` hook. The candidate was transferred with the workflow's
commands:

```bash
ditto -c -k --sequesterRsrc --keepParent <candidate-app> OpenChamber.app.zip
ditto -x -k OpenChamber.app.zip <transfer-directory>
```

The file remained absent. No credential-dependent signing was attempted. The
signing stage was represented by the transferred app because code signing does
not generate `Contents/Resources/app-update.yml`. Final packages were created
through the production entry point and prepackaged mode:

```bash
OPENCHAMBER_J2K_DESKTOP_BUILD=1 OPENCHAMBER_TARGET_ARCH=arm64 \
CSC_IDENTITY_AUTO_DISCOVERY=false node ./scripts/package.mjs \
  --prepackaged <transferred-app> --mac dmg zip --arm64 --publish=never \
  --config <final-config.json>
```

The updater file remained absent in the prepackaged app, extracted ZIP, and
read-only mounted DMG. The generated transfer ZIP, final ZIP, and DMG hashes
were respectively:

- `61672ce5d3cdf69d26fb244bd2341b281c4ac8a6c079cb40957712000c61f8a2`
- `1293a9474a1f6ee31e242cd716f6148cfb1f77812ee25a0f7485ccf849227b67`
- `ce419ca5025cb52cfdbc62e9411cf238f7ce87f5d26dc669c9ae96672341fe55`

The focused characterization test invokes `package.mjs`, which invokes the
workspace's pinned electron-builder, with the actual macOS arm64 `--dir` and
`--publish=never` boundary. It asserts the updater file inside the generated
unsigned app. Applying that test to the `.22` packaging source fails at the
omitted file; it passes against the `.24` source.

## Investigation boundaries

Release assets were downloaded to a temporary directory, checked before
extraction, and never modified. DMGs were mounted read-only and detached. This
investigation did not publish or alter a release, advance `desktop-channel`,
rerun a workflow, access signing credentials, perform credential-dependent
signing, or access or modify `j2k-laptop`. It did not independently reproduce
the private signature, certificate trust, or hardened-runtime signing process.
