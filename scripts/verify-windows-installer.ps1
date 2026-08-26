# Verify the signed Windows NSIS installer.
#
#   pwsh scripts/verify-windows-installer.ps1 -Version 0.1.0
#
# Requires: Status = Valid Authenticode signature with a timestamp, correct
# product name/version metadata, and an x64 application payload. Optionally
# set EXPECTED_WIN_PUBLISHER to enforce an exact publisher (certificate CN).
param(
    [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Error "error: $Message"
    exit 1
}

$exe = "release/Wrightbench-Setup-$Version-win-x64.exe"
if (-not (Test-Path $exe)) { Fail "missing expected artifact: $exe" }

Write-Host "== Authenticode signature: $exe"
$sig = Get-AuthenticodeSignature -FilePath $exe
Write-Host "Status:         $($sig.Status)"
Write-Host "StatusMessage:  $($sig.StatusMessage)"
if ($sig.SignerCertificate) {
    Write-Host "Signer subject: $($sig.SignerCertificate.Subject)"
    Write-Host "Signer expires: $($sig.SignerCertificate.NotAfter)"
}
if ($sig.Status -ne 'Valid') {
    Fail "Authenticode signature status is '$($sig.Status)' — a production installer must have Status = Valid"
}
if (-not $sig.TimeStamperCertificate) {
    Fail "the signature has no timestamp; production signatures must be timestamped"
}
Write-Host "Timestamped by: $($sig.TimeStamperCertificate.Subject)"

if (-not $sig.SignerCertificate.Subject -or $sig.SignerCertificate.Subject -notmatch 'CN=') {
    Fail "the signer certificate has no subject CN"
}
if ($env:EXPECTED_WIN_PUBLISHER) {
    if ($sig.SignerCertificate.Subject -notlike "*$($env:EXPECTED_WIN_PUBLISHER)*") {
        Fail "signer subject does not contain expected publisher '$($env:EXPECTED_WIN_PUBLISHER)'"
    }
    Write-Host "Publisher matches EXPECTED_WIN_PUBLISHER."
}

Write-Host "== Version metadata"
$vi = (Get-Item $exe).VersionInfo
Write-Host "ProductName:    $($vi.ProductName)"
Write-Host "ProductVersion: $($vi.ProductVersion)"
Write-Host "FileVersion:    $($vi.FileVersion)"
if ($vi.ProductName -ne 'Wrightbench') { Fail "ProductName is '$($vi.ProductName)', expected 'Wrightbench'" }
if (-not ($vi.ProductVersion -like "$Version*")) { Fail "ProductVersion '$($vi.ProductVersion)' does not match $Version" }

Write-Host "== Architecture payload"
# The NSIS bootstrap stub itself is a 32-bit PE, so checking the outer PE
# machine type would prove nothing. The installed application payload is the
# embedded 7z archive: require the x64 payload and reject others.
$sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
if (-not $sevenZip) { Fail "7z is required to inspect the installer payload and was not found" }
$listing = & 7z l $exe | Out-String
if ($LASTEXITCODE -ne 0) { Fail "7z could not list the installer contents" }
if ($listing -notmatch 'app-64\.7z') { Fail "installer does not contain the x64 application payload (app-64.7z)" }
if ($listing -match 'app-32\.7z|app-arm64\.7z') { Fail "installer unexpectedly contains a non-x64 application payload" }
Write-Host "x64 payload (app-64.7z) present."

Write-Host "Windows installer verified: valid timestamped signature, correct metadata, x64 payload."
