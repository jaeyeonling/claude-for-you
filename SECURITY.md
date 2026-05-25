# Security Policy

## Scope

This is a self-hosted, single-operator proxy. There is no public deployment to attack, no maintainer-operated service to compromise on behalf of users, and no shared credentials. Vulnerabilities in this repository affect **the operator who runs it**, not third parties.

That said, vulnerabilities still matter. Especially:

- **Token exfiltration** paths (OAuth refresh token, access token, Anthropic credentials).
- **Admin endpoint** auth bypass or CSRF.
- **SSRF or header injection** in the upstream proxy.
- **Credential leakage** through logs, error messages, or webhook payloads.
- **Information disclosure** in admin UI that would reveal operator secrets.

## Reporting

If you find a vulnerability that fits the scope above, please **do not open a public GitHub issue**. Instead:

1. Open a private security advisory via GitHub: `Security` tab → `Report a vulnerability`. This creates a private CVE-track conversation.
2. Or email the maintainer (address listed in the repo profile).

Please include:

- A description of the vulnerability and the impact.
- Steps to reproduce (a minimal POC is appreciated).
- The commit hash you're testing against.
- Whether you're aware of the same issue in upstream dependencies.

Expect a response within 7 days. If the vulnerability is confirmed, a fix is typically committed within 14 days for HIGH/CRITICAL findings.

## Out of scope

The following are **not** vulnerabilities the maintainer will accept reports for:

- Anthropic ToS compliance — read `README.md` disclaimer. Whether running this proxy violates Anthropic's terms is the operator's call, not a vulnerability in this code.
- Issues that require physical access to the operator's machine, EC2 instance, or AWS account.
- Issues that require credentials the attacker already has (e.g., "an attacker with a valid API key can issue requests").
- Issues in third-party services (Anthropic, Discord, Slack, AWS, GitHub). Report those to the service owner.
- Theoretical issues without a concrete exploit path.

## Hardening already applied

See `CHANGELOG.md` for the full list. Notable defenses:

- CSRF guard on every state-changing `/admin/*` endpoint (Origin / X-Forwarded-Host check).
- Constant-time API key comparison; the loop deliberately does not short-circuit.
- 4 MB body cap on `/v1/messages`; global concurrency cap; per-IP token bucket (opt-in).
- Token-shaped strings stripped from logs and webhook payloads via `lib/redact.ts`.
- IMDSv2 required on EC2 (terraform module); SSM Session Manager replaces SSH.
- RDS Postgres reachable only from the app SG; storage encrypted.
- `terraform.tfstate`, `.env`, `accounts.json`, `api-keys.json`, captures all gitignored.
- Atomic file writes (0600 mode) for any persisted secret.

## Disclosure timeline

The maintainer will:

1. Acknowledge receipt within 7 days.
2. Confirm or dispute the finding within 14 days.
3. Ship a fix for confirmed HIGH/CRITICAL findings within 30 days.
4. Credit the reporter in the CHANGELOG entry (unless anonymity is requested).

If a fix takes longer than 30 days, the reporter and maintainer will jointly decide on a coordinated disclosure date.
