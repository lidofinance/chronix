# Security boundaries

Chronix is a development network with public fixture keys. Never fund those keys on a public chain
or import real validator/wallet credentials. It is not a production node deployment.

## Running code

The controller runs with Deno `-A` and controls a local Docker daemon. Only run source, patches and
images you trust. Docker resource labels scope cleanup; they are not a security boundary against
malicious code. Review contributor changes before running them on a workstation that has personal
files, credentials or unrelated workloads.

Use disposable VMs or GitHub-hosted runners for untrusted contributions. Do not attach a personal
computer as a self-hosted runner for a public repository. The packaged Chronix service needs
`--privileged` for its private Docker daemon, so it is not a sandbox for hostile software. Do not
mount a host Docker socket, home directory, SSH agent or credential directory into that service. See
[Docker's daemon security model](https://docs.docker.com/engine/security/) and
[GitHub's Actions security guidance](https://docs.github.com/en/actions/reference/security/secure-use).

## Network access

The controller binds to loopback and checks Host/Origin. Its control API is not authenticated for
multiple users. Host/Origin checks do not replace authentication. Publish controller, CL and VC
ports only on `127.0.0.1`; do not expose them to a LAN or the internet. `CHRONIX_ALLOWED_HOSTS` adds
exact host names, such as a Compose service name, for sibling containers on a CI network. A name the
local resolver can map to an attacker (search domains, LLMNR or mDNS spoofing of single-label names)
weakens the DNS-rebinding protection, so use the list only on CI or Compose networks, never on a
developer host with published ports. The internal Engine API requires JWT and VC requests require
its generated bearer token. Keep runtime directories private.

## Releases and reports

Release workflows use GitHub-hosted runners, pinned Actions and job-scoped token permissions.
Checkouts do not persist GitHub credentials. Lighthouse publication is manual; Chronix publication
uses version tags or an explicitly dispatched release. The release PR trigger requires a merged
same-repository PR on the default branch. Review workflow, script and dependency changes before
merging; protect the default branch and release tags in repository settings.

Keep `.env`, credentials and generated keys out of Git. Review reports and logs before upload;
ignore rules cannot remove previously committed data. If a real secret is committed, revoke it
first, then address Git history and any uploaded artifacts. Do not post secrets in public issues.
Use private vulnerability reporting when enabled, or contact the maintainer privately first.
