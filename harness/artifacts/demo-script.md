# Architecture Walkthrough — Video Demo Script

**Duration:** ~4 minutes
**Diagram file:** `artifacts/architecture.excalidraw`
**How to use:** Open the .excalidraw file at https://excalidraw.com (drag & drop), then follow this script while recording your screen.

---

## INTRO (15 sec)
"Hi, I'm going to walk you through the architecture of my multi-agent coding harness. 
This is a system where multiple AI agents negotiate, design, and implement software 
through a structured protocol. Let me show you how it all fits together."

[Camera: Full diagram overview, zoom out to show all 10 zones]

---

## ZONE 1: ENTRY POINT (20 sec)
[Camera: Zoom into top-left — ENTRY POINT zone]

"Everything starts here with the user. When you run `harness/run.sh` with a goal, 
it parses the arguments, initializes or resumes session state, spawns the Manager agent, 
and then monitors the communication bus for progress and heartbeats. 
Think of this as the bootstrap — it gets everything running and then watches over it."

---

## ZONE 2: CORE LOOP (30 sec)
[Camera: Pan right to CORE LOOP zone]

"The Manager agent is the heart of the harness. It's defined in `agents/manager.md` 
and it classifies every request by complexity — trivial, small, medium, or complex. 
For non-trivial tasks, it drives a round-based negotiation protocol: 
Round 1 gathers design and feasibility input, Round 2 collects objections and assent. 
If agents deadlock after 3 rounds, the Manager reduces scope and restarts. 
The Manager owns scope, budget, and deadlines."

---

## ZONE 3: COMMUNICATION BUS (20 sec)
[Camera: Pan down to the COMMUNICATION BUS zone spanning the middle]

"This is the communication backbone — `bus/messages.jsonl`. It's an append-only JSONL file. 
Every agent writes here and reads from here. No agent talks directly to another. 
The schema is documented in `schema.md` and validated by `validate.mjs`. 
Every message has a timestamp, agent name, action, and payload. 
This gives us a complete, auditable log of every decision."

---

## ZONE 4: STATE & ARTIFACTS (15 sec)
[Camera: Pan down-left to STATE & ARTIFACTS]

"The harness tracks everything in `state/session.json` — the current phase, 
round count, complexity level, deadlock count, and a full history. 
Meanwhile, Negotiated Implementation Plans — NIP documents — are stored in `artifacts/`, 
and generated code lands in `workspace/`."

---

## ZONE 5: PRIMARY AGENTS (25 sec)
[Camera: Pan right to PRIMARY AGENTS zone]

"There are two primary agents with persistent context. The **Architect** owns system design — 
it creates interface contracts, writes specs, and delegates to the planner subagent. 
The **Engineer** owns implementation feasibility — it builds risk registers, 
estimates effort, creates tickets, and delegates to the coder subagent. 
Both agents communicate exclusively through the bus and follow the Manager's cadence."

---

## ZONE 6: STATELESS SUBAGENTS (15 sec)
[Camera: Pan down to STATELESS SUBAGENTS zone]

"Below the primary agents are five stateless subagents: planner, executor — also called coder, 
verifier, browser, and web-search. Each call is a fresh session — no memory between invocations. 
This keeps them focused and prevents context pollution. 
The Manager and primary agents call these as needed."

---

## ZONE 7: FRONTEND SERVER (20 sec)
[Camera: Pan down-left to FRONTEND SERVER zone]

"The frontend is an Express + WebSocket server running on port 3333. 
It provides multi-session management — you can switch between agent sessions, 
track token usage, route sessions by key, and search across sessions. 
There's also a Discord bridge that lets you interact with agents through Discord."

---

## ZONE 8: PI AGENT CORE (15 sec)
[Camera: Pan further down-left to PI AGENT CORE zone]

"The Pi Agent Core is the orchestrator — it's defined in `AGENTS.md` and provides the 
underlying framework. It exposes four tools — read, write, edit, and bash — 
and manages the agent pool. Every agent in the system runs on top of this core."

---

## ZONE 9: SERVICES (10 sec)
[Camera: Pan right to SERVICES zone]

"Finally, we have external services. SearXNG provides web search capabilities 
for the web-search subagent, and a Discord bot allows external interaction 
through Discord channels. These are defined in the `services/` directory."

---

## FLOW SUMMARY (15 sec)
[Camera: Zoom out to full diagram, trace arrows with cursor]

"So to trace the full flow: a user submits a goal → run.sh bootstraps and spawns the Manager → 
the Manager classifies and writes to the bus → the Architect and Engineer respond with 
design and feasibility → the NIP is negotiated and signed → implementation is delegated 
to subagents → results flow back through the bus → state is updated → 
and the frontend provides visibility throughout. 
All of this runs on the Pi Agent Core with external services providing web search and Discord connectivity."

---

## OUTRO (10 sec)
"That's the architecture of the multi-agent coding harness. 
Thanks for watching!"

[End]
