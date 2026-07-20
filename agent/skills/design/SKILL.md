---
name: design
description: Claude-style design methodology. Use when designing UX flows, module architectures, or interface contracts. Emphasizes progressive disclosure of detail (L1→L2→L3), tradeoff analysis, and machine-verifiable contracts.
---

# Design Methodology

A structured design process inspired by Claude's approach: start with *what* before *how*, define contracts before implementations, and progressively disclose detail.

## Problem Understanding

Before designing anything, restate the problem in your own words. Identify:

- **Who** are the stakeholders? (users, other systems, other agents)
- **What** is the core job to be done? (one sentence)
- **Constraints** — budget, existing systems, hard requirements, non-negotiables
- **Success criteria** — how will we know the design is correct?

Output this as a concise "Problem Statement" block before any design artifacts.

## UX Flow Design

Design the user experience end-to-end BEFORE defining modules:

- For UI systems: sketch every screen, every transition, every error state. Use a linear flow: "Screen A → Screen B (on click) → Screen C (on submit) → Error: ..."
- For API systems: enumerate every endpoint, request/response shape, status codes, error bodies
- For CLI tools: every command, every flag, every stdout/stderr output
- For agent systems: every message type, every protocol step, every timeout/retry

Do NOT define modules or code yet. Stay in the user's perspective.

## Module Decomposition

Only after the UX flow is complete, decompose into modules:

1. Draw boundaries around distinct responsibilities
2. Each module must have EXACTLY one reason to change
3. List dependencies explicitly — what does each module need from others?
4. Name every module with a clear, self-documenting name

## Interface Contracts

For EVERY module boundary, define a machine-verifiable contract. Use TypeScript-like notation:

```
// File: path/to/module.ts
function functionName(param: ParamType, options?: OptionsType): ReturnType | ErrorType
// Errors: ErrorType1 (when condition), ErrorType2 (when condition)
```

Every contract must specify:
- **Signature** — exact function/endpoint name, parameter names and types
- **Return type** — success type AND all error types
- **Error conditions** — when each error is raised (not just the type)
- **Side effects** — what state changes, I/O, or bus messages this produces

Do not use prose for contracts. Use exact types. "Returns a list of users" is insufficient — use `User[]` or `Array<{id: string, name: string}>`.

## Design Levels

Use progressive disclosure of detail. Every design artifact must state its level:

- **L1 — Conceptual:** Boxes and arrows. Module names, responsibilities, data flow direction. No types, no signatures. For initial alignment and brainstorming.
- **L2 — Concrete:** Interface contracts with exact types and error states. Module boundaries are locked. Dependencies are explicit. For handoff to implementation.
- **L3 — Implementation-Ready:** L2 contracts plus: data structures, algorithms, persistence schemas, configuration values, environment variables. For direct coding.

Always start at L1 and get alignment before moving to L2. Never jump to L3 without L2 sign-off.

## Tradeoffs & Rationale

Every design decision must be justified:

- For each non-obvious choice, document: **what you chose**, **alternatives considered**, **why rejected**
- Format as a table or bullet list under a "Tradeoffs" heading
- If a decision has no reasonable alternative, state: "Only viable approach — no tradeoff to make"

This is NOT optional. The Architect is accountable for every decision in the design.

## Rules

- Never design modules before understanding the UX flow
- Every contract must be machine-verifiable — exact types, not prose
- Always state the Design Level (L1/L2/L3) on every artifact
- Every non-obvious decision must have documented tradeoffs
- Do not make implementation decisions (algorithms, data structures) at L1 or L2
- If you don't know something, say so — don't guess types or signatures
