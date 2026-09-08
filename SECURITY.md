# Security policy

Argus is a browser-accessible shell, file browser and process viewer. A vulnerability can
therefore expose the same account that runs it. Please treat security reports as private
until a fix is available.

## Supported versions

Only the latest published release and the current `master` branch receive security fixes.
Argus is still pre-1.0; upgrading to the latest release may include configuration changes.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** button in the repository's Security tab. If private
reporting is unavailable, email the address shown on Andrea de Ruvo's GitHub profile and do
not open a public issue.

Please include the affected version, operating system, deployment topology, reproduction
steps and the impact you believe is possible. You should receive an acknowledgement within
72 hours and a status update within seven days.

## Deployment boundary

Argus binds to loopback by default. Keep it on a trusted LAN, behind a VPN such as Tailscale,
or behind an SSH tunnel. Do not expose its HTTP port directly to the public internet.

The access token has the authority of the account running Argus. TLS protects it in transit;
device tokens limit the cost of losing one browser; `--allow-write` and `--allow-proxy` are
off unless explicitly enabled. None of these controls turn Argus into a multi-user security
boundary or a sandbox.

The complete deployment model is documented in the
[Security wiki page](https://github.com/andreaderuvo/argus/wiki/Security).
