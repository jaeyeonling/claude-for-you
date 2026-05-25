---
name: Bug report
about: Something doesn't work as documented.
title: ''
labels: bug
---

**Setup**

- Deployment: [ local dev / EC2+Docker / something else ]
- Bun version (`bun --version`):
- Snapshot age (`/admin` boot banner):
- Account pool: [ single-account / multi-account ]

**What happened**

Steps and expected vs actual. If a request failed, include the request method+path and the HTTP status.

**Logs**

Run with `LOG_LEVEL=debug` and paste relevant lines. **Strip OAuth tokens, API keys, and webhook URLs first.** The `redact()` function exists but only catches token-shaped strings — anything else needs to be removed by hand.

**Anthropic response headers (if applicable)**

```
service_tier:
anthropic-ratelimit-unified-status:
anthropic-ratelimit-unified-remaining:
```

**Notes**

Anything else that helps. ToS-related questions should go to Anthropic, not here.
