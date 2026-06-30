#!/usr/bin/env bash
# Agents tool — comprehensive matrix test
# Runs all permutations and asserts exact behavior.

set -uo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../../.." || exit 1

PASS=0
FAIL=0
FAILED_TESTS=()

red()    { printf '\033[31m%s\033[0m' "$1"; }
green()  { printf '\033[32m%s\033[0m' "$1"; }
yellow() { printf '\033[33m%s\033[0m' "$1"; }
cyan()   { printf '\033[36m%s\033[0m' "$1"; }
bold()   { printf '\033[1m%s\033[0m' "$1"; }

section() { echo; echo "=== $(cyan "$1") ==="; }

pass() { PASS=$((PASS+1)); echo "  $(green '✓') $1"; }

fail() {
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$1")
    echo "  $(red '✗') $1"
    if [ -n "${2:-}" ]; then
        echo "       $(yellow 'reason:') $2"
    fi
}

assert_contains() {
    local name="$1" haystack="$2" needle="$3"
    if grep -qF -- "$needle" <<<"$haystack"; then
        pass "$name"
    else
        fail "$name" "expected to contain '$needle' — got: $(head -c 300 <<<"$haystack")"
    fi
}

assert_not_contains() {
    local name="$1" haystack="$2" needle="$3"
    if grep -qF -- "$needle" <<<"$haystack"; then
        fail "$name" "expected NOT to contain '$needle' — got: $(head -c 300 <<<"$haystack")"
    else
        pass "$name"
    fi
}

assert_exit() {
    local name="$1" got="$2" want="$3"
    if [ "$got" = "$want" ]; then
        pass "$name (exit $got)"
    else
        fail "$name" "expected exit $want, got $got"
    fi
}

assert_count() {
    local name="$1" haystack="$2" needle="$3" want="$4"
    local got
    got=$(grep -oF "$needle" <<<"$haystack" | wc -l | tr -d ' ')
    if [ "$got" = "$want" ]; then
        pass "$name (count=$got)"
    else
        fail "$name" "expected $want occurrences of '$needle', got $got"
    fi
}

RUN_ID="m$(date +%s)"
BG_PIDS=()
cleanup_sessions() {
    for pid in "${BG_PIDS[@]:-}"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    sleep 0.3
}
trap cleanup_sessions EXIT

mksess() {
    echo "${RUN_ID}-$1-$$"
}

# Helper: log in (auto-register) and exit immediately via --once with no messages
# Using `timeout 2` so it returns even when nothing's pending.
quick_login() {
    timeout 2 ./tools agents login "$@" --once 2>/dev/null || true
}

# ============================================================
section "1. Login auto-register matrix"
# ============================================================

# 1.1 login --agent-name --agent-main (main agent, instant register + login)
S=$(mksess l1)
quick_login --agent-name lead --agent-main --session "$S"
DISC=$(./tools agents discover --session "$S" --format json 2>&1)
assert_contains "main auto-registered with main_ prefix" "$DISC" '"agent_id":"main_'
assert_contains "  is_main:true on the record" "$DISC" '"is_main":true'

# 1.2 second --agent-main on same session errors
OUT=$(./tools agents login --agent-name lead2 --agent-main --once --session "$S" 2>&1); RC=$?
assert_exit "second --agent-main fails" "$RC" "1"
assert_contains "  friendly error names existing main" "$OUT" "main agent is already registered"

# 1.3 login --agent-name peer auto-registers as subagent
quick_login --agent-name peer1 --session "$S"
DISC=$(./tools agents discover --session "$S" --format json 2>&1)
assert_contains "peer auto-registered with agt_ prefix" "$DISC" '"agent_id":"agt_0001"'

# 1.4 second peer goes to agt_0002 (monotonic)
quick_login --agent-name peer2 --session "$S"
DISC=$(./tools agents discover --session "$S" --format json 2>&1)
assert_contains "second peer is agt_0002" "$DISC" '"agent_id":"agt_0002"'

# 1.5 login with same name re-attaches (no error)
quick_login --agent-name peer1 --session "$S"
DISC=$(./tools agents discover --session "$S" --format json 2>&1)
assert_count "peer1 still single record" "$DISC" '"agent_name":"peer1"' 1

# 1.6 --debug enables session debug
S=$(mksess l6)
quick_login --agent-name lead --agent-main --debug --session "$S"
META=$(cat ~/.genesis-tools/agents/"$S"/session-meta.json 2>/dev/null || echo "")
assert_contains "--debug writes session-meta debug:true" "$META" '"debug":true'

# ============================================================
section "2. Login takeover-fail-loud"
# ============================================================

# 2.1 second login on same agent FAILS LOUD (no takeover; user must kill old)
S=$(mksess l21)
quick_login --agent-name lead --agent-main --session "$S"
./tools agents login --agent-name lead --session "$S" > /tmp/log21-old.log 2>&1 &
OLD_PID=$!
BG_PIDS+=("$OLD_PID")
LOCK=$(./tools agents discover --session "$S" --format json | tools json 2>/dev/null | grep -oE 'main_[a-z0-9]+' | head -1)
LOCKPATH=~/.genesis-tools/agents/"$S"/slots/"$LOCK".login
for i in $(seq 1 30); do
    [ -f "$LOCKPATH" ] && break
    sleep 0.1
done
[ -f "$LOCKPATH" ] && pass "background stream login holds slot lock" || fail "background stream login holds slot lock"

OUT=$(timeout 3 ./tools agents login --agent-name lead --once --session "$S" 2>&1 || true)
assert_contains "second login fails loudly (no takeover)" "$OUT" "already held by pid"
assert_contains "  hint suggests killing the old pid" "$OUT" "kill"
if kill -0 "$OLD_PID" 2>/dev/null; then
    pass "old login is still running (we did not steal its lock)"
else
    fail "old login is still running" "expected alive, but it exited"
fi

kill "$OLD_PID" 2>/dev/null
wait "$OLD_PID" 2>/dev/null || true
sleep 0.3
./tools agents message --from lead --to lead --body 'self-ping' --session "$S" > /dev/null 2>&1
# (no recipient registered besides lead; just verify the re-login works after cleanup)
OUT=$(timeout 3 ./tools agents login --agent-name lead --once --session "$S" 2>&1 || true)
assert_not_contains "after old killed, new login does NOT hit lock-held" "$OUT" "already held by pid"
rm -f /tmp/log21-old.log

# ============================================================
section "3. Message matrix"
# ============================================================

S=$(mksess msg)
quick_login --agent-name lead --agent-main --session "$S"
quick_login --agent-name a --session "$S"
quick_login --agent-name b --session "$S"
quick_login --agent-name c --session "$S"

# 3.1 direct by name
OUT=$(./tools agents message --from a --to b --body 'd1' --session "$S" 2>&1); RC=$?
assert_exit "direct by name" "$RC" "0"
assert_contains "  kind=direct" "$OUT" '"kind":"direct"'

# 3.2 direct by id (token starts with agt_)
OUT=$(./tools agents message --from agt_0001 --to agt_0002 --body 'd2' --session "$S" 2>&1); RC=$?
assert_exit "direct by id (sniffed via agt_ prefix)" "$RC" "0"
assert_contains "  recipients list" "$OUT" '"agt_0002"'

# 3.3 broadcast
OUT=$(./tools agents message --from a --body 'bc' --session "$S" 2>&1); RC=$?
assert_exit "broadcast" "$RC" "0"
assert_contains "  kind=broadcast" "$OUT" '"kind":"broadcast"'

# 3.4 multi-recipient names
OUT=$(./tools agents message --from a --to b,c --body 'mr' --session "$S" 2>&1)
assert_contains "multi-recipient: b present" "$OUT" '"agt_0002"'
assert_contains "multi-recipient: c present" "$OUT" '"agt_0003"'

# 3.5 dedup duplicate names
OUT=$(./tools agents message --from a --to b,b --body 'dup' --session "$S" 2>&1)
assert_count "duplicate names → 1 recipient" "$OUT" 'agt_0002' 1

# 3.6 dedup id+name combined for same agent
OUT=$(./tools agents message --from a --to agt_0002,b --body 'mix' --session "$S" 2>&1)
assert_count "id+name same agent → 1 recipient" "$OUT" 'agt_0002' 1

# 3.7 self-target warns
OUT=$(./tools agents message --from a --to a --body 'self' --session "$S" 2>&1)
assert_contains "self-target warning" "$OUT" "recipient list includes the sender"

# 3.8 missing body
OUT=$(./tools agents message --from a --session "$S" 2>&1); RC=$?
assert_exit "missing --body errors" "$RC" "1"
assert_contains "  friendly error" "$OUT" "--body is required"

# 3.9 missing sender
OUT=$(./tools agents message --body 'x' --session "$S" 2>&1); RC=$?
assert_exit "missing --from errors" "$RC" "1"
assert_contains "  lists available senders" "$OUT" "Registered"

# 3.10 unknown sender
OUT=$(./tools agents message --from ghost --body 'x' --session "$S" 2>&1); RC=$?
assert_exit "unknown sender errors" "$RC" "1"

# 3.11 unknown recipient
OUT=$(./tools agents message --from a --to ghost --body 'x' --session "$S" 2>&1); RC=$?
assert_exit "unknown recipient errors" "$RC" "1"

# 3.12 message_id starts at 0001, monotonic
S=$(mksess msgid)
quick_login --agent-name lead --agent-main --session "$S"
quick_login --agent-name a --session "$S"
quick_login --agent-name b --session "$S"
OUT1=$(./tools agents message --from a --to b --body '1' --session "$S")
OUT2=$(./tools agents message --from a --to b --body '2' --session "$S")
OUT3=$(./tools agents message --from a --to b --body '3' --session "$S")
assert_contains "first message is 0001" "$OUT1" '"message_id":"0001"'
assert_contains "second message is 0002" "$OUT2" '"message_id":"0002"'
assert_contains "third message is 0003" "$OUT3" '"message_id":"0003"'

# ============================================================
section "4. Reply / ack matrix"
# ============================================================

S=$(mksess resp)
quick_login --agent-name lead --agent-main --session "$S"
quick_login --agent-name a --session "$S"
quick_login --agent-name b --session "$S"
quick_login --agent-name c --session "$S"

OUT=$(./tools agents message --from a --to b --body 'q1' --session "$S")
MID=$(sed -nE 's/.*"message_id":"([^"]+)".*/\1/p' <<<"$OUT" | head -1)
[ -n "$MID" ] && pass "captured original message_id ($MID)" || fail "captured original message_id"

# 4.1 message --reply with body → kind:reply
OUT=$(./tools agents message --from b --reply "$MID" --body 'r1' --session "$S")
assert_contains "reply with body → kind:reply" "$OUT" '"kind":"reply"'
assert_contains "  carries in_reply_to" "$OUT" "\"in_reply_to\":\"$MID\""

# 4.2 message --reply without body → kind:ack
OUT=$(./tools agents message --from b --reply "$MID" --session "$S")
assert_contains "reply no body → kind:ack" "$OUT" '"kind":"ack"'

# 4.3 original sender (a) sees the reply
OUT=$(timeout 4 ./tools agents login --agent-name a --once --session "$S" 2>/dev/null || true)
assert_contains "  original sender a sees reply" "$OUT" "\"in_reply_to\":\"$MID\""
assert_not_contains "  original sender a does NOT see own original message" "$OUT" '"body":"q1"'

# 4.4 uninvolved peer c does NOT see reply
./tools agents message --from a --to c --body 'c-ping' --session "$S" > /dev/null
OUT=$(timeout 4 ./tools agents login --agent-name c --once --session "$S" 2>/dev/null || true)
assert_contains "  uninvolved c sees own incoming message" "$OUT" '"body":"c-ping"'
assert_not_contains "  uninvolved c does NOT see reply to a's message" "$OUT" "\"in_reply_to\":\"$MID\""

# 4.5 unknown in_reply_to with no --to errors (cannot resolve who to route to)
OUT=$(./tools agents message --from b --reply ffff --session "$S" 2>&1); RC=$?
assert_exit "reply to unknown msg id with no --to errors" "$RC" "1"
assert_contains "  friendly error names the unresolved reply" "$OUT" "Could not resolve original sender"

# 4.6 unknown in_reply_to WITH explicit --to is allowed (recipient given, no need to resolve)
OUT=$(./tools agents message --from b --to a --reply ffff --session "$S" 2>&1); RC=$?
assert_exit "reply to unknown msg id with explicit --to is allowed" "$RC" "0"

# ============================================================
section "5. Visibility matrix"
# ============================================================

# 5.1 Main without --debug does NOT see registered events
S=$(mksess vis1)
quick_login --agent-name lead --agent-main --session "$S"
quick_login --agent-name p --session "$S"
./tools agents message --from p --to lead --body 'm1' --session "$S" > /dev/null
OUT=$(timeout 4 ./tools agents login --agent-name lead --once --session "$S" 2>/dev/null || true)
assert_not_contains "main w/o debug doesn't see registered" "$OUT" '"type":"registered"'
assert_contains "  main does see the message" "$OUT" '"body":"m1"'

# 5.2 Main WITH --debug sees registered events
S=$(mksess vis2)
quick_login --agent-name lead --agent-main --debug --session "$S"
quick_login --agent-name p --session "$S"
./tools agents message --from p --to lead --body 'm1' --session "$S" > /dev/null
OUT=$(timeout 4 ./tools agents login --agent-name lead --once --session "$S" 2>/dev/null || true)
assert_contains "main WITH debug sees registered" "$OUT" '"type":"registered"'

# 5.3 Non-main peer w/o debug does NOT see lifecycle of others
S=$(mksess vis3)
quick_login --agent-name lead --agent-main --session "$S"
quick_login --agent-name p --session "$S"
quick_login --agent-name q --session "$S"
./tools agents message --from p --to q --body 'msg' --session "$S" > /dev/null
OUT=$(timeout 4 ./tools agents login --agent-name q --once --session "$S" 2>/dev/null || true)
assert_not_contains "non-main peer w/o debug: no registered events" "$OUT" '"type":"registered"'
assert_contains "  peer q does see message addressed to it" "$OUT" '"body":"msg"'

# ============================================================
section "6. Discover"
# ============================================================
S=$(mksess disc)
quick_login --agent-name lead --agent-main --session "$S"
quick_login --agent-name a --session "$S"
quick_login --agent-name b --session "$S"

OUT=$(./tools agents discover --session "$S" --format json 2>&1)
assert_contains "discover lists lead" "$OUT" '"agent_name":"lead"'
assert_contains "  has a" "$OUT" '"agent_name":"a"'
assert_contains "  has b" "$OUT" '"agent_name":"b"'

# ============================================================
section "7. Session resolution + error UX"
# ============================================================

# 7.1 invalid JSON in --meta
S=$(mksess err1)
quick_login --agent-name lead --agent-main --session "$S"
OUT=$(./tools agents login --agent-name x --meta 'not-json' --once --session "$S" 2>&1); RC=$?
assert_exit "invalid --meta JSON errors" "$RC" "1"

# 7.2 --meta as array (not object) errors
OUT=$(./tools agents login --agent-name x --meta '[]' --once --session "$S" 2>&1); RC=$?
assert_exit "--meta as array errors" "$RC" "1"
assert_contains "  hint says must be object" "$OUT" "must be a JSON object"

# 7.3 missing session resolution errors
OUT=$(env -u CLAUDE_CODE_SESSION_ID ./tools agents discover 2>&1); RC=$?
if [ "$RC" != "0" ] && grep -qF "could not resolve a session" <<<"$OUT"; then
    pass "no session resolvable → friendly error"
else
    fail "no session resolvable → friendly error" "got exit $RC, out: $(head -c 200 <<<"$OUT")"
fi

# ============================================================
section "Summary"
# ============================================================
echo
echo "Total: $(bold $((PASS+FAIL)))  $(green "PASS: $PASS")  $(red "FAIL: $FAIL")"
if [ $FAIL -gt 0 ]; then
    echo
    echo "$(red 'Failed tests:')"
    for t in "${FAILED_TESTS[@]}"; do echo "  - $t"; done
    exit 1
fi
exit 0
