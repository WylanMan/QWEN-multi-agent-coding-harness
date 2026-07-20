## Task Summary

**What was built:** Fixed two bugs in the Kanban frontend: (1) enhanced markdown renderer with heading, list, blockquote, and horizontal rule support, including plain-text stripping for those patterns; (2) fixed name-entry overlay staying visible by changing CSS to `display: none` and removing the transition, plus added a double-connect guard in the WebSocket `connect()` function.

**Files modified:** `public/index.html`

**Key decisions:** None — spec was followed exactly.

**What was tried and rejected:** N/A

**Known limitations:** None

**Verify results:** All 7 checks passed:
- PASS: h1 heading support
- PASS: list support
- PASS: blockquote support
- PASS: hr support
- PASS: display none (name-entry fix)
- PASS: double-connect guard (WebSocket.OPEN check)
- PASS: server syntax
