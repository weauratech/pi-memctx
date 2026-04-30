# Security Policy

## Supported versions

The `main` branch is the active development line until the project publishes versioned releases.

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities, prompt-injection bypasses, or accidental sensitive data exposure.

Use GitHub private vulnerability reporting if enabled, or contact the maintainers through the repository's security contact once published.

## Sensitive data policy

pi-memctx stores and searches local Markdown memory packs. Those packs must never contain:

- secrets;
- tokens;
- passwords;
- private keys;
- credentials;
- full payment card numbers;
- sensitive customer data;
- sensitive production payloads;
- private third-party data that cannot be shared with an agent.

Give the agent the map, not the keys.

## Threat model notes

pi-memctx is local-first and does not require hosted infrastructure, but local files can still influence agent behavior. Treat memory packs as trusted-but-reviewable inputs.

Relevant risks:

- accidental persistence of secrets through `memctx_save`;
- prompt injection in Markdown files;
- memory poisoning through incorrect or malicious notes;
- stale decisions overriding current source-of-truth files;
- accidental publication of private packs.

Mitigations:

- `memctx_save` blocks common secret patterns;
- memory remains Markdown and can be reviewed in Git;
- source-of-truth repository files should win over memory notes;
- keep private packs outside public repositories unless intentionally sanitized.

## If sensitive data is committed

1. Stop using the exposed secret immediately.
2. Rotate or revoke it at the source.
3. Remove it from the repository and history before publishing or distributing.
4. Document only safe pointers to approved secret stores or procedures.
