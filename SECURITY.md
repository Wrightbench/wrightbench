# Security policy

## Supported versions

Wrightbench is pre-1.0. Only the **latest published release** receives
security fixes; older 0.x releases are not patched.

## Reporting a vulnerability

Please report vulnerabilities **privately** and give us a chance to fix
them before public disclosure:

1. Go to the repository's
   [Security Advisories page](https://github.com/Wrightbench/wrightbench/security/advisories/new)
   and open a private vulnerability report ("Report a vulnerability").
2. Include reproduction steps, the affected version or commit, and an
   assessment of impact if you have one.

Do **not** report vulnerabilities through public GitHub issues,
discussions, or pull requests.

You should receive an acknowledgement within 7 days. We'll keep you
informed as we triage, fix, and release. Credit is given in the release
notes unless you prefer to stay anonymous.

## Scope notes

Wrightbench spawns your project's local Playwright installation and runs
your test suites — running tests executes project-controlled code, which is
inherent to the product. Reports about a *project's own tests* executing
code are out of scope; reports where a malicious *workspace* can escape the
documented boundaries (e.g. code execution at import time, IPC validation
bypasses, or path escapes past the workspace boundary) are very much in
scope.
