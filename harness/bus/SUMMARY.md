## Task Summary

**What was built:** Two files in the harness bus directory: a human-readable schema reference (`schema.md`) and a runnable JSONL bus message validator (`validate.mjs`).

**Files modified:**
- `/home/cman/.pi/harness/bus/schema.md` — created
- `/home/cman/.pi/harness/bus/validate.mjs` — created (executable)

**Key decisions:** None, spec was sufficient.

**What was tried and rejected:** N/A

**Known limitations:** The validator checks newlines only in string-typed payloads, not recursively inside objects/arrays (per spec). The existing bus has many pre-schema messages that fail validation — this is expected.

**Verify results:**
- `chmod +x` — passed
- `node /home/cman/.pi/harness/bus/validate.mjs` — runs, correctly reports 5 valid / 10 invalid / 5 warnings on existing bus
- `echo '{"timestamp":"2026-01-01T00:00:00Z","agent":"manager","action":"classify","phase":"classifying","task_id":"test","payload":null}' | node -e ...` — passed ("PASS: valid message parsed")
- `node -c validate.mjs` — Syntax OK
