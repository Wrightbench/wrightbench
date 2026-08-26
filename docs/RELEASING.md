# Releasing Wrightbench

This is the complete procedure for shipping a Wrightbench release. The
pipeline is tag-driven: a `vX.Y.Z` tag on a commit that is on `main`
builds, signs, notarizes, verifies, and publishes every platform — or
publishes nothing at all.

## 1. Versioning policy

Wrightbench uses [Semantic Versioning](https://semver.org):

- `vMAJOR.MINOR.PATCH` — production releases (e.g. `v0.2.0`)
- `vMAJOR.MINOR.PATCH-beta.N` / `-rc.N` — prereleases (e.g. `v0.2.0-rc.1`)

While the project is 0.x, minor versions may contain breaking changes.
Version changes reach `main` through a reviewed pull request **before**
tagging — the release workflow never bumps versions itself, and it fails
if the tag doesn't exactly match `package.json`.

## 2. Prepare the version PR

On a branch off `main`:

```bash
npm version <version> --no-git-tag-version
```

This updates `package.json` **and** `package-lock.json` together (never
hand-edit either; the release workflow verifies they agree). Then run the
local checks:

```bash
npm run typecheck
npm run test:uimode
npm run build
```

Commit and open a PR:

```bash
git add package.json package-lock.json
git commit -m "release: prepare vX.Y.Z"
```

## 3. Merge into main

Merge the version PR through the normal review process and wait for the
`CI / test` check to pass on the resulting `main` commit. The release
workflow refuses tags whose commit has no successful CI run.

Optional but recommended for the first release or after packaging
changes: run the **Package smoke** workflow (or a **Release** dry run via
*Actions → Release → Run workflow*, which builds and signs everything
without publishing).

## 4. Tag and push

From an up-to-date `main`:

```bash
git checkout main
git pull --ff-only origin main
git tag -a vX.Y.Z -m "Wrightbench vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

Pushing the tag starts the release workflow.

## 5. Monitor the run

Watch *Actions → Release*. The stages are:

1. **validate** — tag is SemVer, matches `package.json`, the commit is
   contained in `origin/main`, the lockfile is synchronized, CI passed,
   and no published release exists for the tag.
2. **build-macos** (arm64 on `macos-15`, x64 on `macos-15-intel`) — signs
   with the Developer ID certificate (hardened runtime, minimal
   entitlements), notarizes and staples the app, signs + notarizes +
   staples the DMG, then verifies the shipped DMG and ZIP with
   `codesign`, `spctl`, `stapler`, `hdiutil`, and `lipo` (both the main
   executable and the better-sqlite3 native module must match the target
   architecture).
3. **build-windows** (`windows-2025`) — signs the app binaries and the
   NSIS installer with a timestamped Authenticode signature
   (`forceCodeSigning` makes an unsigned build fail), then verifies
   `Get-AuthenticodeSignature` reports `Status = Valid`, the signature is
   timestamped, and product name/version/x64 payload are correct.
4. **build-linux** (`ubuntu-24.04`) — builds AppImage + deb and verifies
   structure, desktop entry, icons, and package identity.
5. **publish** — downloads all platform artifacts into a clean staging
   directory, rejects unexpected or missing files, re-checks formats,
   generates the SPDX SBOM (`npm sbom`) and `SHA256SUMS`, creates GitHub
   provenance attestations for every file, then creates the GitHub
   Release as a draft and flips it to published only after every asset
   uploaded. Prerelease tags are marked as prereleases; stable tags are
   marked latest.

If the mac/win build jobs or publish sit "waiting", the protected
`release` environment is asking for reviewer approval — approve it in the
run's UI.

## 6. Validate the published release

On https://github.com/Wrightbench/wrightbench/releases check the release
contains exactly:

- `Wrightbench-X.Y.Z-mac-arm64.dmg` and `.zip`
- `Wrightbench-X.Y.Z-mac-x64.dmg` and `.zip`
- `Wrightbench-Setup-X.Y.Z-win-x64.exe`
- `Wrightbench-X.Y.Z-linux-x86_64.AppImage`
- `wrightbench_X.Y.Z_amd64.deb`
- `wrightbench-X.Y.Z.spdx.json` (SBOM) and `SHA256SUMS`

Spot-check a download:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify Wrightbench-X.Y.Z-mac-arm64.dmg --repo Wrightbench/wrightbench
```

On a Mac, `spctl --assess --type open --context context:primary-signature -v <dmg>`
must say `accepted … source=Notarized Developer ID`.

## 7. Rolling back / responding to a failed release

- **A build or verification job failed:** nothing was published (only the
  final job publishes). Fix the problem on `main` via PR. If the fix
  changes code, ship it as a **new patch version** — do not reuse or move
  the tag. If the failure was environmental (e.g. a notarization service
  outage), re-run the failed jobs from the Actions UI; the validate
  gates re-run too.
- **publish failed mid-upload:** a draft release may remain. Re-running
  the publish job deletes the leftover draft and re-creates it. Drafts
  are never publicly visible.
- **A published release is bad:** do not delete or overwrite it silently.
  Publish a fixed patch release, then edit the bad release's notes to
  point at the replacement (optionally mark it as not-latest). The
  workflow refuses to republish an existing published tag by design.

## 8. Prereleases

Same procedure with a `-beta.N` or `-rc.N` version, e.g.:

```bash
npm version 0.2.0-rc.1 --no-git-tag-version
# PR, merge, then:
git tag -a v0.2.0-rc.1 -m "Wrightbench v0.2.0-rc.1"
git push origin v0.2.0-rc.1
```

The release is automatically marked **prerelease** and never becomes
"latest".

## 9. Required GitHub secrets

All secrets live in the protected **`release` environment** (Settings →
Environments → release), not in repository-level secrets, so only
release jobs — never PR workflows — can read them.

| Secret | Contents |
| --- | --- |
| `MAC_CSC_LINK` | Base64 of the Developer ID Application certificate export (`.p12`) |
| `MAC_CSC_KEY_PASSWORD` | Password for that `.p12` |
| `APPLE_API_KEY_BASE64` | Base64 of the App Store Connect API key (`.p8`) used for notarization |
| `APPLE_API_KEY_ID` | Key ID of that API key (e.g. `2X9R4HXF34`) |
| `APPLE_API_ISSUER` | Issuer ID (UUID) from App Store Connect |

Windows signing supports **two mutually exclusive modes** (§11); configure
exactly one in the `release` environment. Azure mode wins if both exist.

*Azure Trusted Signing (recommended):*

| Kind | Name | Contents |
| --- | --- | --- |
| Secret | `AZURE_TENANT_ID` | Entra ID Directory (tenant) ID of the service principal |
| Secret | `AZURE_CLIENT_ID` | Application (client) ID of the service principal |
| Secret | `AZURE_CLIENT_SECRET` | Client secret of the service principal |
| Variable | `AZURE_SIGNING_ENDPOINT` | Regional Trusted Signing endpoint, e.g. `https://eus.codesigning.azure.net` |
| Variable | `AZURE_CODE_SIGNING_ACCOUNT` | Trusted Signing account name |
| Variable | `AZURE_CERTIFICATE_PROFILE` | Certificate profile name |
| Variable | `EXPECTED_WIN_PUBLISHER` (optional) | Validated identity CN; the verifier enforces it when set |

*Classic PFX certificate:*

| Kind | Name | Contents |
| --- | --- | --- |
| Secret | `WIN_CSC_LINK` | Base64 of the Authenticode certificate (`.pfx`/`.p12`) |
| Secret | `WIN_CSC_KEY_PASSWORD` | Password for that certificate |

The workflows map `MAC_CSC_LINK`/`MAC_CSC_KEY_PASSWORD` to
electron-builder's `CSC_LINK`/`CSC_KEY_PASSWORD` in the macOS job only;
the Windows values are read only in the Windows job, which fails closed
when neither mode (or only part of one mode) is configured. The
notarization key is decoded into `RUNNER_TEMP`, referenced via
`APPLE_API_KEY` (+ `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), and deleted
in an always-running cleanup step. Key contents are never printed.

## 10. Apple certificate and notarization setup

1. In an Apple Developer (paid) account, create a **Developer ID
   Application** certificate (Xcode → Settings → Accounts → Manage
   Certificates, or developer.apple.com), and export it from Keychain
   Access as a `.p12` with a strong password.
2. `base64 -i DeveloperID.p12 | pbcopy` → save as `MAC_CSC_LINK`; the
   export password → `MAC_CSC_KEY_PASSWORD`.
3. In App Store Connect → Users and Access → Integrations → **App Store
   Connect API**, create a **Team key** with the *Developer* role.
   Download the `.p8` (downloadable once).
4. `base64 -i AuthKey_XXXX.p8 | pbcopy` → `APPLE_API_KEY_BASE64`; the Key
   ID → `APPLE_API_KEY_ID`; the Issuer ID shown on that page →
   `APPLE_API_ISSUER`.
5. Delete local copies of the `.p12`/`.p8` when done, or store them in a
   password manager — never in the repository.

## 11. Windows signing setup

The Windows release job supports two mutually exclusive modes and
**fails closed** until exactly one is fully configured — no production
tag can ever publish an unsigned installer.

### Option A (recommended): Azure Trusted Signing

Produces standard timestamped Authenticode signatures from a
Microsoft-managed HSM; certificates are short-lived and rotated by the
service, which is fine because signatures are RFC3161-timestamped
(Microsoft's `timestamp.acs.microsoft.com` by default).

1. Azure portal → create a **Trusted Signing account** (Basic SKU is
   enough). Note the account name and your region's endpoint URL
   (e.g. East US → `https://eus.codesigning.azure.net`).
2. In the account, complete **Identity validation** (type: Public
   Trust). This legal-identity check is the long pole — start it early
   and check the portal for current eligibility requirements.
3. Create a **certificate profile** (type: Public Trust) bound to the
   validated identity; note the profile name. The validated identity's
   name becomes the certificate subject CN — put it in the optional
   `EXPECTED_WIN_PUBLISHER` variable so the verifier enforces it.
4. Microsoft Entra ID → **App registrations** → new registration (e.g.
   `wrightbench-release-signer`) → create a **client secret** (record
   the value immediately; it is shown once). Note the Directory (tenant)
   ID and Application (client) ID.
5. On the Trusted Signing account → **Access control (IAM)** → assign
   the app registration the role **Trusted Signing Certificate Profile
   Signer**.
6. Fill the `release` environment per the §9 table: three `AZURE_*`
   secrets, three `AZURE_*` variables.

The workflow injects `win.azureSignOptions` only in the release job (so
smoke builds stay unsigned) and electron-builder installs the
`TrustedSigning` PowerShell module on the runner during the build.

### Option B: classic PFX certificate

Buy an Authenticode code-signing certificate (OV or EV) from a CA. If it
is file-exportable (`.pfx`): `base64 -i cert.pfx` → `WIN_CSC_LINK`, its
password → `WIN_CSC_KEY_PASSWORD`.

> **Note:** CA/Browser Forum rules increasingly require private keys in
> hardware (HSM), so many newer certificates cannot be exported as
> `.pfx` at all — which is why Option A is the recommended path.

## 12. Certificate rotation

With Azure Trusted Signing there is no certificate to rotate — the
service rotates its short-lived certificates itself. What does expire is
the service principal's **client secret**: create a new one in the app
registration before the old one lapses and update `AZURE_CLIENT_SECRET`.

For the Apple certificate and the PFX mode:

1. Obtain/renew the certificate and re-export it.
2. Update the environment secrets in place (same names).
3. Run *Actions → Release → Run workflow* (dry run): it builds, signs,
   notarizes, and verifies with the new material without publishing.
4. Revoke the old certificate only after a dry run passes.
5. Existing releases stay valid: macOS notarization tickets outlive the
   certificate, and Windows signatures are RFC3161-timestamped, so
   validity survives certificate expiry.

## 13. Why unsigned artifacts must never be published

- macOS Gatekeeper blocks unsigned/unnotarized apps with a warning users
  cannot easily bypass; "damaged app" reports would follow immediately.
- Windows SmartScreen flags unsigned installers as unknown software.
- Unsigned artifacts carry no publisher identity, so a tampered mirror
  copy would be indistinguishable from a real one.
- Silent downgrades destroy the trust chain: checksums and attestations
  prove *what* was built, signatures prove *who* shipped it. The release
  workflow therefore fails when signing/notarization material is missing
  or when any verification (Gatekeeper, Authenticode, stapling) fails,
  and the unsigned smoke artifacts are confined to short-retention
  workflow storage.

## Appendix: exact release command sequence

```bash
npm version X.Y.Z --no-git-tag-version
npm run typecheck
npm run test:uimode
npm run build
git add package.json package-lock.json
git commit -m "release: prepare vX.Y.Z"
# open PR, get review, merge to main, wait for CI to pass, then:
git checkout main
git pull --ff-only origin main
git tag -a vX.Y.Z -m "Wrightbench vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```
