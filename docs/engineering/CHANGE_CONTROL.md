

# Tsuzuro Data Gateway Change Control

## Branches

- Default branch: main
- Branch pattern: `{type}/{slug}`
- Force push forbidden: yes

## Pull Requests

- Required: no
- Template: `.github/pull_request_template.md`
- Required sections:
- Summary
- Change type and gates
- Test plan
- CI status
- Change record
- Deploy verify
- Risks

## CI

- Required checks:
- No checks declared yet.
- Merge requires green: yes

## Change Records

- Required for: S, Plat, I
- Path pattern: `docs/changes/{yyyy}/{mm}/{yyyy-mm-dd}-{slug}.md`