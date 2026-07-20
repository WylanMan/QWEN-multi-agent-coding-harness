#!/usr/bin/env bash
set -euo pipefail

HARNESS_DIR="${HARNESS_DIR:-$HOME/.pi/harness}"
BUS_FILE="$HARNESS_DIR/bus/messages.jsonl"
STATE_FILE="$HARNESS_DIR/state/session.json"
HEARTBEAT_TIMEOUT="${HARNESS_HEARTBEAT_TIMEOUT:-60}"
DRY_RUN="${HARNESS_DRY_RUN:-}"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log()  { echo -e "${BLUE}[harness]${NC} $*"; }
warn() { echo -e "${YELLOW}[harness]${NC} $*" >&2; }
err()  { echo -e "${RED}[harness]${NC} $*" >&2; }

bus_append() {
  local msg="$1"
  echo "$msg" >> "$BUS_FILE"
}

now() { date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"; }

usage() {
  echo "Usage: $0 [--resume] <goal>"
  echo "  --resume    Resume from last saved state instead of starting fresh"
  echo "  goal        The goal/project description (quote if multi-word)"
  exit 1
}

# ─── Parse args ──────────────────────────────────────────────────────
RESUME=false
GOAL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resume) RESUME=true; shift ;;
    -h|--help) usage ;;
    *) GOAL="$1"; shift ;;
  esac
done

if [[ -z "$GOAL" ]]; then
  err "No goal provided."
  usage
fi

# ─── Initialize or resume ────────────────────────────────────────────
TASK_ID="harness-$(date +%s)"

if $RESUME && [[ -f "$STATE_FILE" ]]; then
  log "Resuming session from $STATE_FILE"
  PHASE=$(node -e "console.log(require('$STATE_FILE').phase)" 2>/dev/null || echo "idle")
  log "Current phase: $PHASE"
  bus_append "{\"timestamp\":\"$(now)\",\"agent\":\"runner\",\"action\":\"run_resumed\",\"phase\":\"$PHASE\",\"task_id\":\"$TASK_ID\",\"payload\":{\"goal\":\"$GOAL\"}}"
else
  log "Starting new harness session"
  mkdir -p "$HARNESS_DIR"/{bus,state,artifacts,workspace}

  # Initialize state
  cat > "$STATE_FILE" << STATEEOF
{"phase":"classifying","active_nip":null,"round_count":0,"complexity":null,"goal":"$GOAL","budget_hours":null,"deadlock_count":0,"history":[]}
STATEEOF

  # Truncate bus for new session
  :> "$BUS_FILE"

  bus_append "{\"timestamp\":\"$(now)\",\"agent\":\"runner\",\"action\":\"run_started\",\"phase\":\"classifying\",\"task_id\":\"$TASK_ID\",\"payload\":{\"goal\":\"$GOAL\"}}"
  bus_append "{\"timestamp\":\"$(now)\",\"agent\":\"manager\",\"action\":\"classify\",\"phase\":\"classifying\",\"task_id\":\"$TASK_ID\",\"payload\":{\"goal\":\"$GOAL\"}}"
fi

# ─── Spawn manager agent ─────────────────────────────────────────────
log "Spawning harness-manager agent..."
log "Goal: $GOAL"
log "Bus: $BUS_FILE"
log "---"

if [[ -n "$DRY_RUN" ]]; then
  log "DRY RUN — would spawn: pi --mode json -p --no-session --model opencode-go/deepseek-v4-pro --append-system-prompt $HARNESS_DIR/agents/manager.md --tools read,write,edit,bash"
  log "DRY RUN complete. No agents spawned."
  exit 0
fi

# Monitor the bus for completion or timeout
LAST_LINE_COUNT=$(wc -l < "$BUS_FILE" 2>/dev/null || echo 0)
STALL_SECONDS=0
MAX_STALL=$HEARTBEAT_TIMEOUT

log "Monitoring bus for progress (timeout: ${MAX_STALL}s)..."

while true; do
  sleep 2
  CURRENT_COUNT=$(wc -l < "$BUS_FILE" 2>/dev/null || echo 0)

  if [[ "$CURRENT_COUNT" -gt "$LAST_LINE_COUNT" ]]; then
    STALL_SECONDS=0
    # Show latest message summary
    LATEST=$(tail -1 "$BUS_FILE" 2>/dev/null)
    AGENT=$(echo "$LATEST" | node -e "process.stdin.on('data',d=>{try{const m=JSON.parse(d);console.log(m.agent||'?')}catch(e){console.log('?')}})" 2>/dev/null || echo "?")
    ACTION=$(echo "$LATEST" | node -e "process.stdin.on('data',d=>{try{const m=JSON.parse(d);console.log(m.action||'?')}catch(e){console.log('?')}})" 2>/dev/null || echo "?")
    echo -e "  ${GREEN}[$AGENT]${NC} $ACTION"
  else
    STALL_SECONDS=$((STALL_SECONDS + 2))
  fi

  LAST_LINE_COUNT=$CURRENT_COUNT

  # Check for completion
  if grep -q '"phase":"done"' "$BUS_FILE" 2>/dev/null; then
    log "${GREEN}Harness session complete.${NC}"
    break
  fi

  # Check for deadlock
  if grep -q '"phase":"deadlocked"' "$BUS_FILE" 2>/dev/null; then
    warn "Harness entered deadlock state."
    break
  fi

  # Timeout warning
  if [[ $STALL_SECONDS -ge $MAX_STALL ]]; then
    warn "No bus activity for ${MAX_STALL}s. Agents may be stalled."
    bus_append "{\"timestamp\":\"$(now)\",\"agent\":\"runner\",\"action\":\"timeout_warning\",\"phase\":\"heartbeat\",\"task_id\":\"$TASK_ID\",\"payload\":{\"stall_seconds\":$STALL_SECONDS}}"
    STALL_SECONDS=0
  fi
done

# ─── Summary ─────────────────────────────────────────────────────────
TOTAL=$(wc -l < "$BUS_FILE" 2>/dev/null || echo 0)
log "Total bus messages: $TOTAL"
bus_append "{\"timestamp\":\"$(now)\",\"agent\":\"runner\",\"action\":\"run_completed\",\"phase\":\"done\",\"task_id\":\"$TASK_ID\",\"payload\":{\"total_messages\":$TOTAL}}"
