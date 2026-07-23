---
"@nanocollective/nanocoder": patch
---

Custom slash commands now receive the full typed argument string via `{{args}}` and a `$ARGUMENTS` placeholder, even when the command declares no parameters.
