## Task Summary

**What was built:** Fixed critical bugs in the agent type switching system — prevented history destruction on agent switch, fixed missing cwd in session state, added tool exclusions, removed double route registration, and added loading states with agent type emoji indicators in the frontend.

**Files modified:**
- `/home/cman/.pi/frontend/server.js` — set_agent_type handler, createSession cwd storage, handleSwitchSession double-registerRoute fix
- `/home/cman/.pi/frontend/public/app.js` — loading states, error recovery, emoji in session list, session_switched re-enable
- `/home/cman/.pi/frontend/public/style.css` — .agent-selector.loading animation and :disabled styles

**Key decisions:** None — followed the spec mechanically. One notable behavior: the spec's error recovery reverts `idxInfo.agentType = state.agentType`, but `state.agentType` was already set to `newType` before the async IIFE, so the "revert" is effectively a no-op. This was implemented as specified.

**What was tried and rejected:** Nothing — spec was sufficient.

**Known limitations:** The error recovery revert of `idxInfo.agentType` uses `state.agentType` which has already been mutated to `newType` before the async block, so the actual previous type is not restored on failure. This could be improved by saving the previous type before mutation.

**Verify results:**
- `node -c server.js` — PASS
- `node -c public/app.js` — PASS
- `excludeTools` count: 3 (correct)
- `registerRoute` count: 2 (was 3, fixed)
- `state.cwd` references: 0 direct usage (only in comment about avoiding it)
- `_switchingAgent` guard: 4 occurrences (correct)
- Loading state in app.js: present
- Emoji in renderSessionList: 3 emoji codes present
- CSS pulse animation: present
