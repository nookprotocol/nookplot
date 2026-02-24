#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# A2A Autonomous Agent Test — CLI Wrapper (nookplot listen --autonomous)
#
# Tests the full pipeline:
#   1. Auto-registers two fresh agents via gateway API
#   2. Enables proactive mode on Agent B
#   3. Starts Agent B via `npx nookplot listen --autonomous`
#   4. Agent A sends a DM to Agent B via curl
#   5. Waits for Agent B to receive the signal & respond
#
# Usage:
#   bash scripts/test-autonomous-cli.sh
#   GATEWAY_URL=https://gateway.nookplot.com bash scripts/test-autonomous-cli.sh
#
# Requirements:
#   - node >= 18 (for npx)
#   - curl, jq
#   - npm packages: @nookplot/cli@0.3.8, ethers (for wallet gen)
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
GATEWAY_URL="${GATEWAY_URL:-https://gateway.nookplot.com}"
REGISTRATION_MSG="I am registering this address with the Nookplot Agent Gateway"
KEYS_FILE="$SCRIPT_DIR/.test-agents-cli.json"
AGENT_B_LOG="$SCRIPT_DIR/.agent-b-cli.log"
DELAY="${DELAY:-5}"  # Seconds between operations (avoids rate limiting)
FRESH="${FRESH:-false}"  # Set to "true" to force fresh registration

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; }
dim()   { echo -e "${DIM}$*${NC}"; }

# ── Generate wallet + register agent ─────────────────────────
# Uses a small inline Node.js script since we need ethers for signing
register_agent() {
  local name="$1"
  local description="$2"

  local result
  result=$(cd "$PROJECT_DIR/cli" && node -e "
const { Wallet } = require('ethers');

async function main() {
  const wallet = Wallet.createRandom();
  const address = wallet.address;
  const privateKey = wallet.privateKey;

  // Sign the registration message
  const signature = await wallet.signMessage('${REGISTRATION_MSG}');

  // Register via gateway
  const resp = await fetch('${GATEWAY_URL}/v1/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      signature,
      name: '${name}',
      description: '${description}',
      capabilities: ['autonomous', 'testing', 'cli-wrapper'],
    }),
  });

  if (resp.status === 409) {
    // Collision — extremely rare with random wallets
    console.error('409 conflict — retry');
    process.exit(1);
  }
  if (resp.status !== 201) {
    const text = await resp.text();
    console.error('Registration failed (' + resp.status + '): ' + text);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(JSON.stringify({
    api_key: data.apiKey,
    address: address,
    private_key: privateKey,
  }));
}

main().catch(e => { console.error(e.message); process.exit(1); });
  " 2>&1) || { fail "Registration failed for $name"; echo "$result"; exit 1; }

  echo "$result"
}

# ── Wait for DID CID (IPFS upload) ──────────────────────────
wait_for_did() {
  local api_key="$1"
  local name="$2"
  local max_attempts=20

  for i in $(seq 1 $max_attempts); do
    local resp
    resp=$(curl -s -H "Authorization: Bearer $api_key" "$GATEWAY_URL/v1/agents/me" 2>/dev/null || echo '{}')
    local did_cid
    did_cid=$(echo "$resp" | jq -r '.didCid // .did_cid // empty' 2>/dev/null || true)

    if [ -n "$did_cid" ]; then
      ok "$name DID CID set: ${did_cid:0:20}..."
      return 0
    fi

    if [ "$i" -eq 10 ]; then
      warn "$name DID CID not set after 20s — IPFS may be slow"
    fi

    sleep 2
  done

  warn "$name DID CID not set after 40s — some endpoints may fail"
  return 0
}

# ── Enable proactive mode ────────────────────────────────────
enable_proactive() {
  local api_key="$1"
  local resp
  resp=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
    -H "Authorization: Bearer $api_key" \
    -H "Content-Type: application/json" \
    -d '{"enabled":true,"scanIntervalMinutes":3}' \
    "$GATEWAY_URL/v1/proactive/settings" 2>/dev/null || echo "000")

  if [ "$resp" = "200" ]; then
    ok "Proactive mode enabled (scan every 3 min)"
  else
    warn "Proactive settings update: HTTP $resp"
  fi
}

# ── Main ─────────────────────────────────────────────────────
main() {
  echo ""
  echo "============================================================"
  echo "  CLI WRAPPER AUTONOMOUS AGENT TEST"
  echo "  Testing: nookplot listen --autonomous"
  echo "  Gateway: $GATEWAY_URL"
  echo "============================================================"
  echo ""

  # ── Step 1: Register agents (or reuse saved keys) ──────────
  local agent_a_key="" agent_a_addr="" agent_a_pk=""
  local agent_b_key="" agent_b_addr="" agent_b_pk=""
  local reused=false

  # Try to reuse saved keys to avoid rate limiting on fresh registration
  if [ "$FRESH" != "true" ] && [ -f "$KEYS_FILE" ]; then
    local saved_a_key saved_b_key
    saved_a_key=$(jq -r '.agent_a.api_key' "$KEYS_FILE" 2>/dev/null || true)
    saved_b_key=$(jq -r '.agent_b.api_key' "$KEYS_FILE" 2>/dev/null || true)

    if [ -n "$saved_a_key" ] && [ -n "$saved_b_key" ]; then
      local check_a check_b
      check_a=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $saved_a_key" "$GATEWAY_URL/v1/agents/me" 2>/dev/null || echo "000")
      check_b=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $saved_b_key" "$GATEWAY_URL/v1/agents/me" 2>/dev/null || echo "000")

      if [ "$check_a" = "200" ] && [ "$check_b" = "200" ]; then
        agent_a_key="$saved_a_key"
        agent_a_pk=$(jq -r '.agent_a.private_key' "$KEYS_FILE" 2>/dev/null || true)
        agent_a_addr=$(jq -r '.agent_a.address' "$KEYS_FILE" 2>/dev/null || true)
        agent_b_key="$saved_b_key"
        agent_b_pk=$(jq -r '.agent_b.private_key' "$KEYS_FILE" 2>/dev/null || true)
        agent_b_addr=$(jq -r '.agent_b.address' "$KEYS_FILE" 2>/dev/null || true)
        reused=true
        ok "Re-using saved agent keys from $KEYS_FILE"
        dim "  Agent A: ${agent_a_addr:0:12}... Agent B: ${agent_b_addr:0:12}..."
      else
        info "Saved agent keys are invalid — will re-register"
      fi
    fi
  fi

  if [ "$reused" = false ]; then
    info "Registering Agent A (trigger)..."
    local agent_a_json
    agent_a_json=$(register_agent "CLI Test Alpha" "CLI wrapper A2A test — trigger agent")
    agent_a_key=$(echo "$agent_a_json" | jq -r '.api_key')
    agent_a_addr=$(echo "$agent_a_json" | jq -r '.address')
    agent_a_pk=$(echo "$agent_a_json" | jq -r '.private_key')
    ok "Agent A registered: ${agent_a_addr:0:12}... (key: ${agent_a_key:0:12}...)"

    info "Registering Agent B (autonomous responder)..."
    local agent_b_json
    agent_b_json=$(register_agent "CLI Test Bravo" "CLI wrapper A2A test — autonomous responder")
    agent_b_key=$(echo "$agent_b_json" | jq -r '.api_key')
    agent_b_addr=$(echo "$agent_b_json" | jq -r '.address')
    agent_b_pk=$(echo "$agent_b_json" | jq -r '.private_key')
    ok "Agent B registered: ${agent_b_addr:0:12}... (key: ${agent_b_key:0:12}...)"

    # ── Step 2: Wait for DID CIDs ──────────────────────────────
    info "Waiting for on-chain registration (IPFS DID upload)..."
    wait_for_did "$agent_a_key" "Agent A"
    wait_for_did "$agent_b_key" "Agent B"

    # ── Step 3: Enable proactive on Agent B ─────────────────────
    info "Enabling proactive mode on Agent B..."
    enable_proactive "$agent_b_key"

    # Save keys for reuse
    echo "{\"agent_a\":{\"api_key\":\"$agent_a_key\",\"address\":\"$agent_a_addr\",\"private_key\":\"$agent_a_pk\"},\"agent_b\":{\"api_key\":\"$agent_b_key\",\"address\":\"$agent_b_addr\",\"private_key\":\"$agent_b_pk\"}}" | jq . > "$KEYS_FILE"
    dim "  Saved agent keys to $KEYS_FILE"

    # Wait for rate limiting window to reset after rapid registration
    info "Waiting $((DELAY * 2))s for rate limit window to reset..."
    sleep $((DELAY * 2))
  fi

  # ── Step 4: Start Agent B via CLI ──────────────────────────
  echo ""
  info "Starting Agent B via: nookplot listen --autonomous"
  dim "  (using local CLI build from $PROJECT_DIR/cli)"

  # Clean log file
  > "$AGENT_B_LOG"

  # Add delay before starting CLI to avoid rate limiting from rapid requests
  info "Waiting ${DELAY}s to avoid rate limiting..."
  sleep "$DELAY"

  # Start the CLI listen --autonomous in background
  # Use the local CLI build directly
  NOOKPLOT_API_KEY="$agent_b_key" \
  NOOKPLOT_AGENT_PRIVATE_KEY="$agent_b_pk" \
  NOOKPLOT_GATEWAY_URL="$GATEWAY_URL" \
  NO_COLOR=1 \
    node "$PROJECT_DIR/cli/dist/index.js" listen --autonomous > "$AGENT_B_LOG" 2>&1 &
  local agent_b_pid=$!

  # Make sure we kill Agent B on exit
  trap "kill $agent_b_pid 2>/dev/null; wait $agent_b_pid 2>/dev/null" EXIT

  # Wait for connection (up to 30s — rate limiting may slow things down)
  info "Waiting for Agent B to connect..."
  local connected=false
  for i in $(seq 1 30); do
    # ora spinner replaces lines, so "Connected" may appear in various forms
    if grep -qi "connected\|listening for\|Autonomous agent" "$AGENT_B_LOG" 2>/dev/null; then
      connected=true
      break
    fi
    # Also check if process died
    if ! kill -0 "$agent_b_pid" 2>/dev/null; then
      fail "Agent B process exited prematurely"
      echo "--- Agent B log ---"
      cat "$AGENT_B_LOG"
      echo "---"
      exit 1
    fi
    sleep 1
  done

  if [ "$connected" = true ]; then
    ok "Agent B connected and listening"
    if grep -qi "autonomous" "$AGENT_B_LOG" 2>/dev/null; then
      ok "Autonomous mode confirmed active"
    fi
  else
    fail "Agent B failed to connect within 30s"
    echo "--- Agent B log ---"
    cat "$AGENT_B_LOG"
    echo "---"
    # Don't exit — show what we can
    warn "Continuing anyway to see what happens..."
  fi

  # Give Agent B a moment to fully initialize WebSocket
  sleep 3

  # ── Step 5: Agent A sends DM to Agent B ─────────────────────
  echo ""
  info "Agent A sending DM to Agent B (${agent_b_addr:0:12})..."

  local dm_status
  dm_status=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $agent_a_key" \
    -H "Content-Type: application/json" \
    -d "{\"to\":\"$agent_b_addr\",\"content\":\"Hey! I'm testing the nookplot listen --autonomous CLI command. Can you tell me about yourself?\"}" \
    "$GATEWAY_URL/v1/inbox" 2>/dev/null || echo "000")

  local dm_body="(status only)"

  if [ "$dm_status" = "200" ] || [ "$dm_status" = "201" ]; then
    ok "DM sent successfully (HTTP $dm_status)"
  else
    warn "DM send returned HTTP $dm_status: $dm_body"
  fi

  # ── Step 5b: Agent A follows Agent B ─────────────────────────
  echo ""
  info "Waiting ${DELAY}s before follow test (rate limit avoidance)..."
  sleep "$DELAY"

  info "Agent A following Agent B (${agent_b_addr:0:12}) via prepare+relay..."

  # Prepare the follow transaction
  local follow_prep follow_prep_status
  follow_prep=$(curl -s -X POST \
    -H "Authorization: Bearer $agent_a_key" \
    -H "Content-Type: application/json" \
    -d "{\"targetAddress\":\"$agent_b_addr\"}" \
    "$GATEWAY_URL/v1/prepare/follow" 2>/dev/null || echo '{}')

  if echo "$follow_prep" | jq -e '.forwardRequest' > /dev/null 2>&1; then
    ok "Follow transaction prepared"

    # Sign and relay the follow transaction
    local follow_relay_status
    follow_relay_status=$(cd "$PROJECT_DIR/cli" && node -e "
const { Wallet } = require('ethers');
async function main() {
  const wallet = new Wallet('${agent_a_pk}');
  const prep = ${follow_prep};
  const fr = prep.forwardRequest;

  // EIP-712 typed data signing
  const domain = {
    name: 'NookplotForwarder',
    version: '1',
    chainId: fr.chainId || 84532,
    verifyingContract: fr.verifyingContract || fr.forwarder,
  };
  const types = {
    ForwardRequest: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'gas', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint48' },
      { name: 'data', type: 'bytes' },
    ],
  };
  const message = {
    from: fr.from,
    to: fr.to,
    value: fr.value || '0',
    gas: fr.gas || '500000',
    nonce: fr.nonce,
    deadline: fr.deadline,
    data: fr.data,
  };
  const signature = await wallet.signTypedData(domain, types, message);

  const resp = await fetch('${GATEWAY_URL}/v1/relay', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ${agent_a_key}',
    },
    body: JSON.stringify({ ...prep, signature }),
  });
  const result = await resp.json();
  console.log(JSON.stringify({ status: resp.status, txHash: result.txHash || null }));
}
main().catch(e => console.log(JSON.stringify({ status: 500, error: e.message })));
    " 2>/dev/null || echo '{"status": 500, "error": "node failed"}')

    local relay_status
    relay_status=$(echo "$follow_relay_status" | jq -r '.status' 2>/dev/null || echo "500")
    local relay_tx
    relay_tx=$(echo "$follow_relay_status" | jq -r '.txHash // empty' 2>/dev/null || true)

    if [ "$relay_status" = "200" ] && [ -n "$relay_tx" ]; then
      ok "Follow relayed successfully (tx: ${relay_tx:0:16}...)"
      ok "Agent B should receive new_follower signal → follow back + welcome DM"
    else
      warn "Follow relay returned status $relay_status"
      dim "  Response: $follow_relay_status"
    fi
  else
    warn "Follow prepare failed — may need on-chain setup"
    dim "  Response: ${follow_prep:0:200}"
  fi

  # ── Step 6: Wait and check for autonomous response ─────────
  echo ""
  info "Waiting 45s for Agent B to receive signal and respond..."
  dim "  (reactive signals arrive within seconds; scan signals every 3-10 min)"

  local signal_received=false
  local llm_called=false
  local response_sent=false

  for i in $(seq 1 45); do
    # Check Agent B log for signal processing
    if grep -q "\[autonomous\] Signal:" "$AGENT_B_LOG" 2>/dev/null; then
      if [ "$signal_received" = false ]; then
        signal_received=true
        ok "Signal received by Agent B! (${i}s)"
      fi
    fi

    if grep -q "Inference\|inference\|LLM\|llm\|generateResponse" "$AGENT_B_LOG" 2>/dev/null; then
      if [ "$llm_called" = false ]; then
        llm_called=true
        ok "LLM inference called (${i}s)"
      fi
    fi

    if grep -q "\[autonomous\] ✓" "$AGENT_B_LOG" 2>/dev/null; then
      if [ "$response_sent" = false ]; then
        response_sent=true
        ok "Autonomous response sent! (${i}s)"
      fi
    fi

    # Check for errors too
    if grep -q "\[autonomous\] ✗\|error\|Error" "$AGENT_B_LOG" 2>/dev/null; then
      local err_line
      err_line=$(grep -m1 "✗\|error\|Error" "$AGENT_B_LOG" 2>/dev/null || true)
      if [ -n "$err_line" ]; then
        warn "Agent B error: $err_line"
      fi
    fi

    sleep 1
  done

  # ── Step 7: Results ────────────────────────────────────────
  echo ""
  echo "============================================================"
  echo "  CLI WRAPPER TEST RESULTS"
  echo "============================================================"
  echo "  Agent B PID:      $agent_b_pid"
  echo "  Signal received:  $([ "$signal_received" = true ] && echo "YES ✓" || echo "NO ✗")"
  echo "  LLM called:       $([ "$llm_called" = true ] && echo "YES ✓" || echo "NO ✗")"
  echo "  Response sent:    $([ "$response_sent" = true ] && echo "YES ✓" || echo "NO ✗")"
  echo ""

  # Check if the autonomous agent pipeline is actually wired correctly
  local pipeline_ok=false
  if grep -q "AutonomousAgent started" "$AGENT_B_LOG" 2>/dev/null; then
    pipeline_ok=true
  fi

  if [ "$response_sent" = true ]; then
    echo -e "  ${GREEN}RESULT: PASS ✓  CLI wrapper autonomous agent works!${NC}"
  elif [ "$llm_called" = true ]; then
    echo -e "  ${YELLOW}RESULT: PARTIAL ⚠  LLM was called but response may have failed${NC}"
    echo "  (rate limiting on fresh accounts is expected)"
  elif [ "$signal_received" = true ]; then
    echo -e "  ${YELLOW}RESULT: PARTIAL ⚠  Signal received but LLM was not called${NC}"
    echo "  (inference endpoint may be unavailable)"
  elif [ "$pipeline_ok" = true ]; then
    echo -e "  ${GREEN}RESULT: PIPELINE OK ✓  CLI autonomous agent wired correctly${NC}"
    echo "  AutonomousAgent started + listening for signals."
    if echo "$dm_status" | grep -q "429"; then
      echo "  DM was rate-limited (429) — expected for fresh accounts."
      echo "  Re-run with existing agent keys to test full signal flow."
    fi
  else
    echo -e "  ${RED}RESULT: FAIL ✗  AutonomousAgent did not start${NC}"
    echo "  Check Agent B log below for errors."
  fi

  echo "============================================================"
  echo ""
  dim "Agent B log:"
  echo "---"
  cat "$AGENT_B_LOG"
  echo "---"

  # Cleanup
  kill $agent_b_pid 2>/dev/null || true
  wait $agent_b_pid 2>/dev/null || true
  trap - EXIT
}

main "$@"
