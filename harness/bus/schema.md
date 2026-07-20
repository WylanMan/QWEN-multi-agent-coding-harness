# Harness Bus Message Schema

Every message on bus/messages.jsonl is a single-line JSON object.

## Required Fields (all messages)

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string (ISO 8601) | When the message was created |
| `agent` | enum | One of: manager, architect, engineer, planner, coder, system, runner |
| `action` | string | What action was performed (e.g., classify, design_proposal, feasibility_analysis) |
| `payload` | any | The message body — can be string, object, array, or null |

## Conditional Fields

| Field | Type | Required when | Description |
|-------|------|---------------|-------------|
| `phase` | enum | agent=manager or agent=runner | Current harness phase: classifying, negotiating_round_1, negotiating_round_2, implementing, done, deadlocked, heartbeat |
| `task_id` | string | agent != system and action != heartbeat | Correlation ID linking messages across a task |
| `in_reply_to` | string (ISO 8601) | replying to a prior message | Timestamp of the message being replied to |

## Agent-Specific Actions

- **manager**: classify, post_goal, request_design, request_feasibility, merge_nip, present_nip, request_objections, amend_nip, sign_nip, delegate_implementation, resolve_deadlock, heartbeat
- **architect**: design_proposal, objections, assent, delegate_to_planner, review_task_graph, heartbeat
- **engineer**: feasibility_analysis, objections, assent, create_ticket, delegate_to_coder, review_implementation, file_amendment, heartbeat
- **planner**: task_graph, error_ambiguous_brief
- **coder**: implementation_result, error_spec_unclear
- **system**: session_created, session_resumed, session_interrupted
- **runner**: run_started, run_completed, run_failed, timeout_warning, heartbeat

## Phase Transitions

```
idle → classifying → negotiating_round_1 → negotiating_round_2 → implementing → done
                                                    ↓
                                                deadlocked
```

## Validation Rules

1. Every line must be valid JSON
2. `timestamp` must parse as a valid date
3. `agent` must be one of the 7 allowed values
4. `action` must be a non-empty string
5. `payload` must be present (even if null)
6. manager/runner messages must include `phase`
7. Non-heartbeat, non-system messages should include `task_id`
8. No unescaped newlines within JSON string values (breaks JSONL)
