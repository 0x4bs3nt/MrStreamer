# Signing

Mac releases are signed with a Developer ID, hardened, notarized and stapled. [Checking a build](#checking-a-build) verifies those properties; first-open and Keychain retention across installed updates need their own checks. Signing the Windows installer comes later; see [releasing](releasing.md#windows-signing). Microsoft signs the [Store package](#microsoft-store-package) it delivers.

## Credentials

| What                                        | Where                                                                                 | Expires                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Apple Developer Program membership          | The Account Holder's Apple account                                                    | Yearly renewal                                                     |
| Team ID                                     | Repository variable `APPLE_TEAM_ID`                                                   | Never                                                              |
| Developer ID Application, for releases      | Repository secrets `MAC_CERTIFICATE_P12` (base64 .p12) and `MAC_CERTIFICATE_PASSWORD` | Five years after it was issued (the current one in September 2031) |
| App Store Connect API key, for notarization | Repository secrets `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`         | Never; revoke it to end it                                         |

The release certificate belongs to GitHub Actions only: its private key was generated for it and exists nowhere else. Machines that build signed releases themselves get their own Developer ID, so each can be revoked alone. The notarization key has the Developer role, which can notarize but not manage users, certificates or apps.

Only the Account Holder can create Developer ID certificates. Apple refuses to issue them through the API, so a new one needs a certificate request uploaded at developer.apple.com.

## Setting up or renewing

`scripts/setup-release-signing.sh` walks through every step and stores the results in the repository settings. It needs `gh` signed in with admin access. For the Developer ID it runs `scripts/ci-signing-identity.ts`:

```sh
node scripts/ci-signing-identity.ts request   # key and request in .local/ci-signing, printed for upload
# upload the request at developer.apple.com: Developer ID Application, G2 Sub-CA
node scripts/ci-signing-identity.ts finish    # finds the certificate, stores the .p12 and its password
node scripts/ci-signing-identity.ts status    # the team's Developer ID certificates and expiry dates
```

`finish` and `status` look certificates up through the App Store Connect API when `ASC_KEY_PATH`, `ASC_KEY_ID` and `ASC_ISSUER_ID` name an Admin key; without one, pass the downloaded certificate with `finish --cer <file>`.

Renew the release certificate a few months before it expires. A new certificate from the same team keeps updates working: macOS checks the team and app id, not the certificate. Releases signed with the old one keep opening after it expires, because their signatures are timestamped.

## If something is compromised

- **The notarization key:** revoke it in App Store Connect under Users and Access > Integrations, then create a new one with the wizard.
- **The release certificate:** revoke it at developer.apple.com and create a new one. Revoking can stop apps signed with it from opening, so publish a release signed with the new certificate right away.
- A lapsed membership stops notarization; published releases keep working.

## Checking a build

The release workflow checks every Mac build. By hand:

```sh
codesign --verify --deep --strict --verbose=2 "Mr. Streamer.app"
codesign -dv "Mr. Streamer.app"          # Authority=Developer ID Application, TeamIdentifier, flags=0x10000(runtime)
spctl --assess --type execute --verbose "Mr. Streamer.app"   # source=Notarized Developer ID
xcrun stapler validate "Mr. Streamer.app"
spctl --assess --type open --context context:primary-signature --verbose Mr-Streamer-*.dmg
xcrun stapler validate Mr-Streamer-*.dmg
```

To sign on your own Mac, keep a Developer ID Application identity in your keychain and set `APPLE_API_KEY` (the path of a .p8), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` for notarization before `pnpm dist:mac`.

## Microsoft Store package

The release workflow builds the [Store package](releasing.md#microsoft-store-package) unsigned. Partner Center takes it that way, and once it passes certification the Store signs what it delivers with Microsoft's certificate. That needs no certificate of ours; don't buy one for the Store.

Windows only installs a signed package, so the release job signs a copy for its own test. It makes a certificate whose subject is the package's publisher, `CN=A132E842-C4C9-40BF-83C4-D304E7952C2D`, trusts it on that runner alone and installs the copy; the runner and the certificate are gone after the job. The artifact stays unsigned. A package that installs this way shows the package works, not that the Store trusts it.

To try a dry run's package on a Windows PC, do the same in an administrator PowerShell. `signtool` comes with the Windows SDK.

```powershell
$cert = New-SelfSignedCertificate -Type Custom -Subject "CN=A132E842-C4C9-40BF-83C4-D304E7952C2D" `
  -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
Export-Certificate -Cert $cert -FilePath test.cer
Import-Certificate -FilePath test.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
signtool sign /fd SHA256 /sha1 $cert.Thumbprint Mr-Streamer-<version>-win-x64.msix
Add-AppxPackage Mr-Streamer-<version>-win-x64.msix
```

Afterwards, remove the package with `Get-AppxPackage MrStreamerOSS.Mr.Streamer | Remove-AppxPackage`, and delete the certificate from both stores: while it's trusted, anything signed with it installs as Mr. Streamer on that PC. Remove a test package before installing Mr. Streamer from the Store too, since both carry the same identity.
