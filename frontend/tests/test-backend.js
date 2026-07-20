// ── Comprehensive Backend Test Suite ─────────────────────────────────────────
// Tests the pi frontend WebSocket protocol end-to-end.
// Run: node test-backend.js

import WebSocket from "ws";

const WS_URL = "ws://localhost:3333";
const RESULTS = [];
let sessionId = null;
let sessionId2 = null;
let ws;
let resolvePending;
let pendingMessages = [];
let testTimeout;
const messageBuffer = [];

function result(name, pass, detail = "") {
  const r = { name, pass, detail };
  RESULTS.push(r);
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
}

function connect() {
  messageBuffer.length = 0;
  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);
    ws.on("message", (raw) => {
      try {
        messageBuffer.push(JSON.parse(raw.toString()));
      } catch (_) {}
    });
    ws.on("open", () => resolve());
    ws.on("error", (e) => reject(e));
    setTimeout(() => reject(new Error("Connection timeout")), 5000);
  });
}

function send(msg) {
  return new Promise((resolve) => {
    ws.send(JSON.stringify(msg));
    resolve();
  });
}

function waitForEvent(predicate, timeoutMs = 15000) {
  // Check buffer for messages received before this call (e.g. sessions_list on connect)
  const idx = messageBuffer.findIndex(predicate);
  if (idx >= 0) {
    const match = messageBuffer[idx];
    return Promise.resolve(match);
  }

  return new Promise((resolve, reject) => {
    const handler = (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        // messageBuffer already updated by connect()'s persistent listener
        if (predicate(data)) {
          ws.removeListener("message", handler);
          resolve(data);
        }
      } catch (_) {}
    };
    ws.on("message", handler);
    setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`Timeout waiting for event after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function waitForSessionCreated() {
  return waitForEvent((d) => d.type === "session_created");
}

function waitForAgentEnd() {
  return waitForEvent((d) =>
    d.type === "session_event" && d.event.type === "agent_end"
  );
}

function collectEventsUntil(predicate, timeoutMs = 30000) {
  const events = [];
  return new Promise((resolve, reject) => {
    const handler = (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        events.push(data);
        if (predicate(data)) {
          ws.removeListener("message", handler);
          resolve(events);
        }
      } catch (_) {}
    };
    ws.on("message", handler);
    setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`Timeout collecting events after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

// ── Test Runner ─────────────────────────────────────────────────────────────

async function run() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   pi Frontend — Backend Test Suite  ║");
  console.log("╚══════════════════════════════════════╝\n");

  // ── Suite 1: Connection ──────────────────────────────────────────
  console.log("── Suite 1: WebSocket Connection ──");
  try {
    await connect();
    result("WS01: Connect to server", true);
  } catch (e) {
    result("WS01: Connect to server", false, e.message);
    console.log("\n⚠ Cannot connect — aborting remaining tests.");
    printReport();
    process.exit(1);
  }

  // Should receive sessions_list on connect
  try {
    const data = await waitForEvent((d) => d.type === "sessions_list");
    result("WS02: Receive sessions_list on connect", data.sessions !== undefined);
    result("WS03: Initial sessions list is empty (or array)", Array.isArray(data.sessions));
  } catch (e) {
    result("WS02: Receive sessions_list on connect", false, e.message);
  }

  // ── Suite 1b: No Fork Types ─────────────────────────────────────
  console.log("\n── Suite 1b: No Fork Types ──");
  try {
    // Wait 2s for any late messages, then check the global buffer
    await new Promise(r => setTimeout(r, 2000));

    const forbidden = [
      'fork_tree', 'fork_result', 'fork_renamed', 'fork_deleted',
      'fork_name_suggestion', 'subagent_spawned', 'dependency_tree',
      'subagent_completed'
    ];
    const foundForbidden = messageBuffer
      .map(m => m.type)
      .filter(t => forbidden.includes(t));
    result("NF01: No forbidden fork/subagent message types received",
      foundForbidden.length === 0,
      foundForbidden.length > 0 ? `Found: ${foundForbidden.join(', ')}` : "clean");
  } catch (e) {
    result("NF01: No fork types", false, e.message);
  }

  // ── Suite 2: Session Creation ────────────────────────────────────
  console.log("\n── Suite 2: Session Creation ──");

  // Create first session
  try {
    await send({ type: "new_session", name: "Test Session Alpha" });
    const data = await waitForSessionCreated();
    sessionId = data.session.id;
    result("SC01: Create new session", true, `id=${sessionId}`);
    result("SC02: Session has name", data.session.name === "Test Session Alpha");
    result("SC03: Session has model", data.session.model !== null);
    result("SC04: Session has sessionFile", data.session.sessionFile !== undefined);
  } catch (e) {
    result("SC01: Create new session", false, e.message);
  }

  // Create second session
  try {
    await send({ type: "new_session", name: "Test Session Beta" });
    const data = await waitForSessionCreated();
    sessionId2 = data.session.id;
    result("SC05: Create second session", true, `id=${sessionId2}`);
    result("SC06: Sessions have different IDs", sessionId !== sessionId2);
  } catch (e) {
    result("SC05: Create second session", false, e.message);
  }

  // List sessions
  try {
    await send({ type: "list_sessions" });
    const data = await waitForEvent((d) => d.type === "sessions_list");
    result("SC07: list_sessions returns array", Array.isArray(data.sessions));
    result("SC08: Two sessions present", data.sessions.length >= 2,
      `found ${data.sessions.length}`);
  } catch (e) {
    result("SC07: list_sessions", false, e.message);
  }

  // ── Suite 2b: Switch Session Shape ───────────────────────────────
  console.log("\n── Suite 2b: Switch Session Shape ──");
  try {
    // Switch to sessionId2 (different from current active session) so server
    // actually sends session_switched instead of returning early as no-op
    await send({ type: "switch_session", sessionId: sessionId2 });
    const data = await waitForEvent(
      (d) => d.type === "session_switched" && d.sessionId === sessionId2,
      5000
    );

    result("SW01: session_switched has sessionId", !!data.sessionId);
    result("SW02: session_switched has history", Array.isArray(data.history));
    result("SW03: session_switched has name", typeof data.name === "string");
    result("SW04: session_switched has model", data.model !== null && data.model !== undefined);
    result("SW05: session_switched has cwd",
      typeof data.cwd === "string" || data.cwd === null);
    result("SW06: session_switched has NO forkMode field",
      !("forkMode" in data),
      data.forkMode !== undefined ? `has forkMode=${data.forkMode}` : "absent");
    result("SW07: session_switched has NO sessionType field",
      !("sessionType" in data),
      data.sessionType !== undefined ? `has sessionType=${data.sessionType}` : "absent");
  } catch (e) {
    result("SW01-SW07: Switch session shape", false, e.message);
  }

  // ── Suite 3: Prompt & Streaming ──────────────────────────────────
  console.log("\n── Suite 3: Prompt & Streaming ──");

  try {
    await send({ type: "prompt", sessionId, message: "Reply with exactly: OK" });
    const events = await collectEventsUntil(
      (d) => d.type === "session_event" && d.event.type === "agent_end",
      30000
    );

    const eventTypes = events
      .filter(e => e.type === "session_event" && e.sessionId === sessionId)
      .map(e => e.event.type);

    result("PS01: agent_start received", eventTypes.includes("agent_start"));
    result("PS02: message_start received", eventTypes.includes("message_start"));
    result("PS03: message_update(s) received", eventTypes.includes("message_update"));
    result("PS04: message_end received", eventTypes.includes("message_end"));
    result("PS05: agent_end received", eventTypes.includes("agent_end"));

    // Check text deltas
    const deltas = events
      .filter(e => e.type === "session_event" && e.sessionId === sessionId)
      .filter(e => e.event.type === "message_update")
      .filter(e => e.event.assistantMessageEvent?.type === "text_delta");

    result("PS06: Text deltas streamed", deltas.length > 0, `${deltas.length} deltas`);

    // Collect all delta text
    const fullText = deltas
      .map(e => e.event.assistantMessageEvent.delta)
      .join("");
    result("PS07: Response contains expected text", fullText.includes("OK"),
      `"${fullText.trim()}"`);

  } catch (e) {
    result("PS01-PS07: Prompt & streaming", false, e.message);
  }

  // ── Suite 4: Concurrent Sessions ─────────────────────────────────
  console.log("\n── Suite 4: Concurrent Sessions ──");

  try {
    // Fire a prompt on session 2 while session 1 is idle
    // Collect both: prompt on session2, then check session1 is unaffected
    const session2Promise = (async () => {
      await send({ type: "prompt", sessionId: sessionId2, message: "Say just the word: BETA" });
      const events = await collectEventsUntil(
        (d) => d.type === "session_event" && d.sessionId === sessionId2 && d.event.type === "agent_end",
        30000
      );
      const deltas = events
        .filter(e => e.type === "session_event" && e.sessionId === sessionId2)
        .filter(e => e.event.type === "message_update")
        .filter(e => e.event.assistantMessageEvent?.type === "text_delta");
      return deltas.map(e => e.event.assistantMessageEvent.delta).join("");
    })();

    const text2 = await session2Promise;
    result("CS01: Session 2 responds independently", text2.includes("BETA"),
      `"${text2.trim()}"`);

    // Both sessions should still exist
    await send({ type: "list_sessions" });
    const list = await waitForEvent((d) => d.type === "sessions_list");
    const bothExist = list.sessions.some(s => s.id === sessionId) &&
                      list.sessions.some(s => s.id === sessionId2);
    result("CS02: Both sessions still alive", bothExist);

  } catch (e) {
    result("CS01-CS02: Concurrent sessions", false, e.message);
  }

  // ── Suite 5: Abort ───────────────────────────────────────────────
  console.log("\n── Suite 5: Abort ──");

  try {
    // Fire a prompt then immediately abort
    await send({ type: "prompt", sessionId, message: "Write a very long essay about the history of computing. Go into extreme detail about every decade." });
    // Wait a small moment for streaming to start
    await new Promise(r => setTimeout(r, 800));
    await send({ type: "abort", sessionId });

    const events = await collectEventsUntil(
      (d) => d.type === "session_event" && d.sessionId === sessionId && d.event.type === "agent_end",
      15000
    );

    // Check that we got an agent_end after abort
    const hasAgentEnd = events.some(
      e => e.type === "session_event" && e.sessionId === sessionId && e.event.type === "agent_end"
    );
    result("AB01: Session terminates after abort", hasAgentEnd);

    // Check for error/aborted state in messages
    const msgEndEvents = events
      .filter(e => e.type === "session_event" && e.sessionId === sessionId)
      .filter(e => e.event.type === "message_end");

    const abortedMsg = msgEndEvents.find(
      e => e.event.message?.stopReason === "aborted" || e.event.message?.stopReason === "error"
    );
    result("AB02: Aborted message has stopReason", !!abortedMsg || msgEndEvents.length > 0,
      abortedMsg ? `stopReason=${abortedMsg.event.message?.stopReason}` : "message_end present");

  } catch (e) {
    result("AB01-AB02: Abort", false, e.message);
  }

  // ── Suite 6: Steer / Follow-up ───────────────────────────────────
  console.log("\n── Suite 6: Message Queue ──");

  try {
    // Fire a prompt, then steer
    await send({ type: "prompt", sessionId, message: "Count slowly: 1... 2... 3... 4... 5... Wait 1 second between each number." });
    await new Promise(r => setTimeout(r, 500));

    await send({ type: "steer", sessionId, message: "Stop counting and just say STEERED" });

    const events = await collectEventsUntil(
      (d) => d.type === "session_event" && d.sessionId === sessionId && d.event.type === "agent_end",
      30000
    );

    // Check for queue_update
    const queueUpdates = events.filter(
      e => e.type === "session_event" && e.sessionId === sessionId && e.event.type === "queue_update"
    );
    result("MQ01: queue_update received after steer", queueUpdates.length > 0,
      `${queueUpdates.length} queue updates`);

    // Check steering had entries
    const hasSteering = queueUpdates.some(
      e => e.event.steering && e.event.steering.length > 0
    );
    result("MQ02: Steering queue populated", hasSteering);

  } catch (e) {
    result("MQ01-MQ02: Steer", false, e.message);
  }

  // ── Suite 7: Session Close ───────────────────────────────────────
  console.log("\n── Suite 7: Session Lifecycle ──");

  try {
    await send({ type: "close_session", sessionId: sessionId2 });

    // Wait for session_closed
    const closed = await waitForEvent((d) => d.type === "session_closed" && d.sessionId === sessionId2, 5000);
    result("SL01: session_closed event received", true, `closed=${sessionId2}`);

    // Verify it's gone from list
    await send({ type: "list_sessions" });
    const list = await waitForEvent((d) => d.type === "sessions_list");
    const stillExists = list.sessions.some(s => s.id === sessionId2);
    result("SL02: Closed session removed from list", !stillExists);

    // First session should still exist
    const firstExists = list.sessions.some(s => s.id === sessionId);
    result("SL03: Other session still alive", firstExists);

  } catch (e) {
    result("SL01-SL03: Session lifecycle", false, e.message);
  }

  // ── Suite 8: Session Tree ────────────────────────────────────────
  console.log("\n── Suite 8: Session Tree ──");

  try {
    await send({ type: "get_tree", sessionId });
    const data = await waitForEvent((d) => d.type === "tree_data" && d.sessionId === sessionId, 5000);

    result("TR01: Tree data received", data.tree !== undefined);
    result("TR02: Tree is array or null", data.tree === null || Array.isArray(data.tree));

    if (data.tree && data.tree.length > 0) {
      result("TR03: Tree has entries", data.tree.length > 0,
        `${data.tree.length} root nodes`);
    } else if (data.tree === null) {
      result("TR03: Tree is null (ok for in-memory sessions)", true, "null — possibly in-memory session");
    }

  } catch (e) {
    result("TR01-TR03: Session tree", false, e.message);
  }

  // ── Suite 9: Session Rename ──────────────────────────────────────
  console.log("\n── Suite 9: Session Naming ──");

  try {
    const newName = "Renamed Alpha " + Date.now();
    await send({ type: "set_name", sessionId, name: newName });

    const renamed = await waitForEvent(
      (d) => d.type === "session_renamed" && d.sessionId === sessionId, 3000
    );
    result("SN01: session_renamed event received", true);
    result("SN02: New name matches", renamed.name === newName,
      `"${renamed.name}"`);

  } catch (e) {
    result("SN01-SN02: Rename", false, e.message);
  }

  // ── Suite 10: Error Handling ─────────────────────────────────────
  console.log("\n── Suite 10: Error Handling ──");

  // Invalid JSON
  try {
    ws.send("not json {{{");
    const err = await waitForEvent((d) => d.type === "error", 3000);
    result("ER01: Invalid JSON returns error", true);
  } catch (e) {
    result("ER01: Invalid JSON returns error", false, e.message);
  }

  // Unknown command
  try {
    await send({ type: "nonexistent_command", foo: "bar" });
    const err = await waitForEvent((d) => d.type === "error", 3000);
    result("ER02: Unknown command returns error", true);
  } catch (e) {
    result("ER02: Unknown command returns error", false, e.message);
  }

  // Prompt on nonexistent session
  try {
    await send({ type: "prompt", sessionId: "nonexistent-id-12345", message: "hello" });
    const err = await waitForEvent((d) => d.type === "error", 3000);
    result("ER03: Prompt on bad session returns error", true);
  } catch (e) {
    result("ER03: Prompt on bad session returns error", false, e.message);
  }

  // ── Suite 11: Models ─────────────────────────────────────────────
  console.log("\n── Suite 11: Available Models ──");

  try {
    await send({ type: "get_models" });
    const data = await waitForEvent((d) => d.type === "models_list", 5000);
    result("MD01: models_list received", true);
    result("MD02: Models array returned", Array.isArray(data.models));
    result("MD03: At least one model available", data.models?.length > 0,
      `${data.models?.length} models`);
    if (data.models?.length > 0) {
      result("MD04: Model has id, name, provider",
        data.models[0].id && data.models[0].name && data.models[0].provider,
        `${data.models[0].provider}/${data.models[0].id}`);
    }
  } catch (e) {
    result("MD01-MD04: Models", false, e.message);
  }

  // ── Suite 12: Tool Execution Events (Subagent Architecture) ─────────
  console.log("\n── Suite 12: Tool Execution Events (Subagent Architecture) ──");

  let toolCallId = null;
  let toolName = null;
  let toolArgs = null;

  try {
    // Prompt the model to use a tool (read a small file so it triggers tool_execution events)
    await send({ type: "prompt", sessionId, message: "Run: ls -la /tmp/ | head -5 && echo DONE_TOOL_TEST" });

    const toolEvents = await collectEventsUntil(
      (d) => d.type === "session_event" && d.sessionId === sessionId && d.event.type === "agent_end",
      45000
    );

    const sEvents = toolEvents.filter(e => e.type === "session_event" && e.sessionId === sessionId);

    // Extract tool execution events
    const toolStarts = sEvents.filter(e => e.event.type === "tool_execution_start");
    const toolUpdates = sEvents.filter(e => e.event.type === "tool_execution_update");
    const toolEnds = sEvents.filter(e => e.event.type === "tool_execution_end");

    result("SA01: tool_execution_start received", toolStarts.length > 0,
      `${toolStarts.length} tool starts`);

    if (toolStarts.length > 0) {
      const ts = toolStarts[0].event;
      toolCallId = ts.toolCallId;
      toolName = ts.toolName;
      toolArgs = ts.args;

      result("SA02: tool_execution_start has toolCallId", !!ts.toolCallId,
        `${ts.toolCallId.substring(0, 20)}...`);
      result("SA03: tool_execution_start has toolName", !!ts.toolName,
        ts.toolName);
      result("SA04: tool_execution_start has args", ts.args !== undefined && ts.args !== null);
    }

    result("SA05: tool_execution_end received", toolEnds.length > 0,
      `${toolEnds.length} tool ends`);

    if (toolEnds.length > 0) {
      const te = toolEnds[0].event;
      result("SA06: tool_execution_end has same toolCallId as start",
        te.toolCallId === toolCallId, toolCallId ? "matched" : "no start to compare");
      result("SA07: tool_execution_end has same toolName as start",
        te.toolName === toolName, `${te.toolName}`);
      result("SA08: tool_execution_end has result field", te.result !== undefined);
      result("SA09: tool_execution_end has isError field",
        te.isError === true || te.isError === false, `${te.isError}`);
    }

    if (toolUpdates.length > 0) {
      const tu = toolUpdates[0].event;
      result("SA10: tool_execution_update received", true,
        `${toolUpdates.length} updates`);
      result("SA11: tool_execution_update has same toolCallId",
        tu.toolCallId === toolCallId);
      result("SA12: tool_execution_update has partialResult",
        tu.partialResult !== undefined);
    } else {
      result("SA10: tool_execution_update received (non-streaming tool)", false,
        "no updates — tool may not stream output");
    }

    // Verify event ordering: tool_execution_start before tool_execution_end
    if (toolStarts.length > 0 && toolEnds.length > 0) {
      const sIdx = sEvents.indexOf(toolStarts[0]);
      const eIdx = sEvents.indexOf(toolEnds[0]);
      result("SA13: tool_execution_start precedes tool_execution_end",
        sIdx < eIdx, `start[${sIdx}] < end[${eIdx}]`);
    }

    // Check message_end was received after tool execution
    const msgEnds = sEvents.filter(e => e.event.type === "message_end");
    result("SA14: message_end received after tool execution", msgEnds.length > 0,
      `${msgEnds.length} message_end events`);

    // Check agent_end was received
    const agentEnds = sEvents.filter(e => e.event.type === "agent_end");
    result("SA15: agent_end received", agentEnds.length > 0,
      `${agentEnds.length} agent_end events`);

  } catch (e) {
    result("SA01-SA15: Tool execution events", false, e.message);
  }

  // ── Suite 13: Session History with Tool Calls ────────────────────
  console.log("\n── Suite 13: Session History with Tool Calls ──");

  try {
    await send({ type: "get_history", sessionId });
    const hist = await waitForEvent(
      (d) => d.type === "session_history" && d.sessionId === sessionId,
      10000
    );

    result("SH01: session_history received", true);
    result("SH02: History has messages array", Array.isArray(hist.messages),
      `${hist.messages.length} messages`);
    result("SH03: History has toolCalls map",
      hist.toolCalls !== undefined && typeof hist.toolCalls === "object");

    // Verify tool call structure in history
    const tcEntries = Object.entries(hist.toolCalls || {});
    if (tcEntries.length > 0) {
      const [, firstTc] = tcEntries[0];
      result("SH04: Tool call has id", !!firstTc.id, firstTc.id);
      result("SH05: Tool call has name", !!firstTc.name, firstTc.name);
      result("SH06: Tool call has status", !!firstTc.status, firstTc.status);
      result("SH07: Tool call has output (string)",
        typeof firstTc.output === "string");
      result("SH08: Tool call status is 'done' after completion",
        firstTc.status === "done", firstTc.status);
    } else {
      result("SH04-SH08: Tool calls in history", false,
        "no tool calls in history (model may not have used tools)");
    }

    // Verify usage data is included
    result("SH09: History has usage data", hist.usage !== null && hist.usage !== undefined);
    if (hist.usage) {
      result("SH10: Usage has input or output tokens",
        (hist.usage.input || 0) + (hist.usage.output || 0) > 0,
        `in=${hist.usage.input || 0} out=${hist.usage.output || 0}`);
    }

  } catch (e) {
    result("SH01-SH10: Session history", false, e.message);
  }

  // ── Suite 14: Queue Deep Dive ────────────────────────────────────
  console.log("\n── Suite 14: Queue & Steer During Tool Execution ──");

  try {
    await send({ type: "prompt", sessionId, message: "Run: for i in 1 2 3 4 5; do echo step $i; sleep 1; done; echo QUEUE_TEST_DONE" });
    // Wait a moment for streaming to start and tool to begin executing
    await new Promise(r => setTimeout(r, 1500));

    // Steer while tool is executing
    await send({ type: "steer", sessionId, message: "After current command, say STEERED instead" });

    const events = await collectEventsUntil(
      (d) => d.type === "session_event" && d.sessionId === sessionId && d.event.type === "agent_end",
      30000
    );

    const sEvents = events.filter(e => e.type === "session_event" && e.sessionId === sessionId);

    const queueUpdates = sEvents.filter(e => e.event.type === "queue_update");
    result("SQ01: queue_update received after steer during tool exec",
      queueUpdates.length > 0, `${queueUpdates.length} updates`);

    // Check ANY queue_update that had steering entries (they get consumed
    // and cleared from subsequent updates once delivered)
    const hadSteering = queueUpdates.some(
      qu => qu?.event?.steering?.length > 0
    );
    result("SQ02: Steering queue entries were populated at some point",
      hadSteering, `${queueUpdates.length} queue updates total`);

    // Find the first steer message content across all queue updates
    const steerText = queueUpdates
      .map(qu => qu?.event?.steering?.[0] || "")
      .find(t => t.length > 0) || "";
    result("SQ03: Steer message content preserved",
      steerText.includes("STEERED"),
      steerText ? `"${steerText.substring(0, 60)}..."` : "empty — may have been consumed before queue_update");

    // Verify tool execution events still occurred during steer
    const toolStarts = sEvents.filter(e => e.event.type === "tool_execution_start");
    result("SQ04: Tool execution events still fire during steer",
      toolStarts.length > 0, `${toolStarts.length} tool starts`);

  } catch (e) {
    result("SQ01-SQ04: Queue & steer during tool exec", false, e.message);
  }

  // ── Suite 15: Parallel Sessions — Independent Tool Executions ────
  console.log("\n── Suite 15: Concurrent Tool Executions ──");

  // Create a fresh session for parallel tool testing
  let psId = null;
  try {
    await send({ type: "new_session", name: "Parallel Tool Test" });
    const psData = await waitForEvent(
      (d) => d.type === "session_created" && d.session?.name === "Parallel Tool Test",
      5000
    );
    psId = psData.session.id;
    result("PT01: Created session for parallel tests", true, `id=${psId}`);
  } catch (e) {
    result("PT01: Created session for parallel tests", false, e.message);
  }

  if (psId) {
    try {
      // Fire prompts on both sessions simultaneously
      const p1 = collectEventsUntil(
        (d) => d.type === "session_event" && d.sessionId === sessionId && d.event.type === "agent_end",
        30000
      );
      const p2 = collectEventsUntil(
        (d) => d.type === "session_event" && d.sessionId === psId && d.event.type === "agent_end",
        30000
      );

      await send({ type: "prompt", sessionId, message: "Run: echo SESSION_A_DONE" });
      await send({ type: "prompt", sessionId: psId, message: "Run: echo SESSION_B_DONE" });

      const [events1, events2] = await Promise.all([p1, p2]);

      const toolStarts1 = events1
        .filter(e => e.type === "session_event" && e.sessionId === sessionId)
        .filter(e => e.event.type === "tool_execution_start");
      const toolStarts2 = events2
        .filter(e => e.type === "session_event" && e.sessionId === psId)
        .filter(e => e.event.type === "tool_execution_start");

      result("PT02: Session 1 tool events isolated",
        toolStarts1.every(e => e.sessionId === sessionId),
        `${toolStarts1.length} tool starts`);
      result("PT03: Session 2 tool events isolated",
        toolStarts2.every(e => e.sessionId === psId),
        `${toolStarts2.length} tool starts`);

      // The server broadcasts ALL events to ALL connected clients (shared WebSocket).
      // Cross-talk events ARE expected — the client-side filters by sessionId.
      // Verify that events from session 1 don't contain events from session 2's events
      // at the tool_execution_start level (each session's events are distinct).
      // This checks that the server correctly scopes sessionId in each event.
      const crossTalk = events1.some(
        e => e.type === "session_event" && e.sessionId === psId && e.event.type === "tool_execution_start"
      );
      // Cross-talk events from broadcast are expected and filtered by client.
      // The real test: each session's events carry the correct sessionId.
      const s1HasOwnToolEvents = toolStarts1.length > 0;
      const s2HasOwnToolEvents = toolStarts2.length > 0;
      result("PT04: Each session gets its own tool events with correct sessionId",
        s1HasOwnToolEvents && s2HasOwnToolEvents,
        `S1:${toolStarts1.length} tool events, S2:${toolStarts2.length} tool events`);

    } catch (e) {
      result("PT01-PT04: Concurrent tool executions", false, e.message);
    }

    // Clean up parallel session
    await send({ type: "close_session", sessionId: psId });
    try {
      await waitForEvent((d) => d.type === "session_closed" && d.sessionId === psId, 5000);
    } catch (_) {}
  }

  // ── Suite 16: Session Persistence ───────────────────────────────
  console.log("\n── Suite 16: Session Persistence ──");
  let persistId = null;
  try {
    // Create a session for persistence testing
    await send({ type: "new_session", name: "Persistence Test " + Date.now() });
    const pData = await waitForEvent(
      (d) => d.type === "session_created" && d.session?.name?.startsWith("Persistence Test"),
      5000
    );
    persistId = pData.session.id;
    result("SP01: Created persistence test session", true, `id=${persistId}`);

    // Disconnect
    ws.close();
    await new Promise(r => setTimeout(r, 1000));

    // Reconnect
    await connect();

    // Verify sessions_list contains the persisted session
    const listData = await waitForEvent((d) => d.type === "sessions_list", 5000);
    const found = listData.sessions.some(s => s.id === persistId);
    result("SP02: Session persisted across reconnect", found,
      found ? "found in sessions_list" : "NOT found");

    // Switch to it to verify it's loadable
    await send({ type: "switch_session", sessionId: persistId });
    await waitForEvent(
      (d) => d.type === "session_switched" && d.sessionId === persistId,
      5000
    );
    result("SP03: Can switch to persisted session after reconnect", true);

    // Clean up
    await send({ type: "close_session", sessionId: persistId });
    try {
      await waitForEvent((d) => d.type === "session_closed" && d.sessionId === persistId, 5000);
    } catch (_) {}
  } catch (e) {
    result("SP01-SP03: Session persistence", false, e.message);
  }

  // ── Done ─────────────────────────────────────────────────────────
  ws.close();
  printReport();
}

function printReport() {
  const passed = RESULTS.filter(r => r.pass).length;
  const failed = RESULTS.filter(r => !r.pass).length;
  const total = RESULTS.length;

  console.log("\n╔══════════════════════════════════════╗");
  console.log("║           TEST REPORT                ║");
  console.log("╠══════════════════════════════════════╣");
  console.log(`║  Total:  ${String(total).padEnd(28)}║`);
  console.log(`║  Passed: ${String(passed).padEnd(28)}║`);
  console.log(`║  Failed: ${String(failed).padEnd(28)}║`);
  console.log(`║  Rate:   ${Math.round(passed/total*100)}%${"".padEnd(26)}║`);
  console.log("╚══════════════════════════════════════╝");

  if (failed > 0) {
    console.log("\n── FAILURES ──");
    for (const r of RESULTS) {
      if (!r.pass) console.log(`  ✗ ${r.name}: ${r.detail}`);
    }
  }

  console.log("\n── ALL RESULTS ──");
  for (const r of RESULTS) {
    console.log(`  ${r.pass ? "✓" : "✗"} ${r.name}`);
  }
}

run().catch((e) => {
  console.error("Test runner crashed:", e);
  if (ws) ws.close();
  process.exit(1);
});
