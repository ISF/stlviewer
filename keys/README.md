# keys/

Out-of-band trust material for verifying release artifacts.

## release-signing.pub

The SSH public key used to sign packaged release artifacts. This file is the
single source of truth for verifying a downloaded `stlviewer.app.zip`.
`scripts/release.sh` uses the corresponding private key locally; the public
half is checked into the repository so anyone can verify a signature without
having to first trust whatever the release page happens to ship.

### Verifying a release

See the `Verifying releases` section of the [top-level README](../README.md).

### Key rotation

If the key is ever lost, compromised, or rotated:

1. Generate a new keypair (or pick a different existing one).
2. Replace `keys/release-signing.pub` in a dedicated commit, with the
   rotation reason in the commit message.
3. From that commit onward, sign with the new key. Earlier releases keep
   their signatures from the old key; verification of historic artifacts
   requires fetching the older key from git history.

A future release may move to Apple Developer ID signing in addition; the
SSH signature stays as a parallel attestation.
