#!/usr/bin/env bash
# TradingView Indicators verification playbook runner
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TODAY=$(date +%F)
RESULTS=()

record() {
  local id="$1" cmd="$2" status="$3" note="${4:-}"
  RESULTS+=("| $id | \`$cmd\` | $status | $note |")
}

run_check() {
  local id="$1"
  shift
  if "$@"; then
    record "$id" "$CMD_LABEL" "PASS" ""
  else
    record "$id" "$CMD_LABEL" "FAIL" "${NOTE:-}"
  fi
}

echo "=== V0 Preflight ==="
CMD_LABEL="git rev-parse --abbrev-ref HEAD && pwd"
BR=$(git rev-parse --abbrev-ref HEAD)
PWD_NOW=$(pwd)
if [[ "$BR" == "feat/tradingview" && "$PWD_NOW" == "$ROOT" ]]; then record V0.1 "$CMD_LABEL" PASS ""; else record V0.1 "$CMD_LABEL" FAIL "branch=$BR pwd=$PWD_NOW"; fi

CMD_LABEL="bun run src/tradingview/index.ts --help"
if bun run src/tradingview/index.ts --help 2>&1 | head -20 | rg -q "indicator" && bun run src/tradingview/index.ts --help 2>&1 | rg -q "charts|scan|indicators"; then
  record V0.2 "$CMD_LABEL" PASS ""
else record V0.2 "$CMD_LABEL" FAIL ""; fi

CMD_LABEL="session check"
if test -f ~/.genesis-tools/tradingview/config.json && rg -c "cookie" ~/.genesis-tools/tradingview/config.json >/dev/null 2>&1; then
  HAS_SESSION=1
  record V0.3 "$CMD_LABEL" PASS "session present"
else
  HAS_SESSION=0
  record V0.3 "$CMD_LABEL" SKIP "NO SESSION"
fi

CMD_LABEL="fixture sizes"
if wc -c src/tradingview/lib/__fixtures__/translate-std-rsi.json src/tradingview/lib/__fixtures__/translate-pub-mdx.json src/tradingview/lib/__fixtures__/chart-frames-rsi.txt src/tradingview/lib/__fixtures__/chart-frames-mdx.txt 2>/dev/null | awk '{if($1<1000) exit 1}'; then
  record V0.4 "$CMD_LABEL" PASS ""
else record V0.4 "$CMD_LABEL" FAIL ""; fi

CMD_LABEL="fixture sanitization"
if rg -l "sessionid=|sessionid_sign=" src/tradingview/lib/__fixtures__/ >/dev/null 2>&1; then
  record V0.5 "$CMD_LABEL" FAIL "credential leak"
else record V0.5 "$CMD_LABEL" PASS ""; fi

echo "=== V1 Static ==="
CMD_LABEL="bun test src/tradingview"
if bun test src/tradingview 2>&1 | tee /tmp/tv-verify-V1.1.log | tail -5 | rg -q "0 fail"; then
  record V1.1 "$CMD_LABEL" PASS ""
else record V1.1 "$CMD_LABEL" FAIL ""; fi

CMD_LABEL="tsgo --noEmit"
if tsgo --noEmit 2>&1 | rg "src/tradingview" >/dev/null 2>&1; then
  record V1.2 "$CMD_LABEL" FAIL "type errors"
else record V1.2 "$CMD_LABEL" PASS ""; fi

CMD_LABEL="lib purity"
if rg -n "import \{[^}]*\bout\b[^}]*\} from \"@app/logger\"" src/tradingview/lib/ >/dev/null 2>&1 || rg -n "\bout\.|console\.|process\.exit" src/tradingview/lib/ >/dev/null 2>&1; then
  record V1.3 "$CMD_LABEL" FAIL ""
else record V1.3 "$CMD_LABEL" PASS ""; fi

CMD_LABEL="no ws package"
if rg -n "from \"ws\"|require\(\"ws\"\)" src/tradingview/ >/dev/null 2>&1; then
  record V1.4 "$CMD_LABEL" FAIL ""
else record V1.4 "$CMD_LABEL" PASS ""; fi

CMD_LABEL="SafeJSON discipline"
if rg -n "JSON\.(parse|stringify)" src/tradingview/ | rg -v "SafeJSON" >/dev/null 2>&1; then
  record V1.5 "$CMD_LABEL" FAIL ""
else record V1.5 "$CMD_LABEL" PASS ""; fi

echo "=== V2 Phase 1 ==="
CMD_LABEL="indicator rsi --once"
timeout 60 bun run src/tradingview/index.ts indicator rsi NASDAQ:AAPL --once > /tmp/tv-verify-V2.1.log 2>&1
EC=$?
if [[ $EC -eq 0 ]] && tail -15 /tmp/tv-verify-V2.1.log | rg -q "RSI" && ! rg -q study_error /tmp/tv-verify-V2.1.log; then
  record V2.1 "$CMD_LABEL" PASS ""
else record V2.1 "$CMD_LABEL" FAIL "exit=$EC"; fi

CMD_LABEL="--bars 50"
ROWS=$(timeout 60 bun run src/tradingview/index.ts indicator rsi NASDAQ:AAPL --once --bars 50 2>&1 | rg -c "^\[.+\] \d{4}-" || true)
if [[ $ROWS -ge 30 && $ROWS -le 50 ]]; then record V2.2 "$CMD_LABEL" PASS "rows=$ROWS"
else record V2.2 "$CMD_LABEL" FAIL "rows=$ROWS"; fi

CMD_LABEL="input override"
timeout 60 bun run src/tradingview/index.ts indicator rsi NASDAQ:AAPL --once --bars 50 > /tmp/tv-verify-V2.3a.log 2>&1
timeout 60 bun run src/tradingview/index.ts indicator rsi NASDAQ:AAPL --once --bars 50 --input Length=2 > /tmp/tv-verify-V2.3b.log 2>&1
A=$(tail -1 /tmp/tv-verify-V2.3a.log | awk '{print $NF}')
B=$(tail -1 /tmp/tv-verify-V2.3b.log | awk '{print $NF}')
if [[ -n "$A" && -n "$B" && "$A" != "$B" ]]; then record V2.3 "$CMD_LABEL" PASS ""
else record V2.3 "$CMD_LABEL" FAIL "a=$A b=$B"; fi

CMD_LABEL="unknown input"
OUT=$(timeout 60 bun run src/tradingview/index.ts indicator rsi NASDAQ:AAPL --once --input bogus=1 2>&1); EC=$?
if [[ $EC -ne 0 ]] && echo "$OUT" | rg -q 'Unknown input "bogus"'; then record V2.4 "$CMD_LABEL" PASS ""
else record V2.4 "$CMD_LABEL" FAIL "exit=$EC"; fi

CMD_LABEL="invalid symbol"
OUT=$(timeout 30 bun run src/tradingview/index.ts indicator rsi NASDAQ:APPL --once 2>&1); EC=$?
if [[ $EC -ne 0 ]] && echo "$OUT" | rg -qi "no such symbol"; then record V2.5 "$CMD_LABEL" PASS ""
else record V2.5 "$CMD_LABEL" FAIL "exit=$EC"; fi

CMD_LABEL="unknown indicator"
OUT=$(timeout 30 bun run src/tradingview/index.ts indicator frobnicator NASDAQ:AAPL --once 2>&1); EC=$?
if [[ $EC -ne 0 ]] && echo "$OUT" | rg -q "Unknown indicator" && echo "$OUT" | rg -q "indicators"; then record V2.6 "$CMD_LABEL" PASS ""
else record V2.6 "$CMD_LABEL" FAIL "exit=$EC"; fi

CMD_LABEL="live mode"
timeout 45 bun run src/tradingview/index.ts indicator rsi BYBIT:BTCUSDT.P --tf 1 > /tmp/tv-verify-V2.7.log 2>&1; EC=$?
if [[ $EC -eq 124 ]] && rg -q "live" /tmp/tv-verify-V2.7.log; then record V2.7 "$CMD_LABEL" PASS ""
else record V2.7 "$CMD_LABEL" FAIL "exit=$EC"; fi

CMD_LABEL="--json"
if timeout 60 bun run src/tradingview/index.ts indicator rsi NASDAQ:AAPL --once --json 2>/dev/null | tail -5 | while IFS= read -r l; do echo "$l" | bun -e 'const x=JSON.parse(await Bun.stdin.text()); if(!x.type) throw new Error("no type")' || echo BADLINE; done | rg -q BADLINE; then
  record V2.8 "$CMD_LABEL" FAIL ""
else record V2.8 "$CMD_LABEL" PASS ""; fi

if [[ $HAS_SESSION -eq 1 ]]; then
  CMD_LABEL='indicator PUB;AGFHDbJ2 --once'
  timeout 90 bun run src/tradingview/index.ts indicator "PUB;AGFHDbJ2" BYBIT:BTCUSDT.P --tf 15 --once > /tmp/tv-verify-V2.9.log 2>&1; EC=$?
  if [[ $EC -eq 0 ]] && rg -q "\[hist\]" /tmp/tv-verify-V2.9.log; then record V2.9 "$CMD_LABEL" PASS ""
  else record V2.9 "$CMD_LABEL" FAIL "exit=$EC"; fi

  CMD_LABEL="signals-only MDX"
  OUT=$(timeout 90 bun run src/tradingview/index.ts indicator "PUB;AGFHDbJ2" BYBIT:BTCUSDT.P --tf 15 --once --signals-only 2>&1)
  if echo "$OUT" | rg -q "\[hist\]" && ! echo "$OUT" | rg -q "^\[.+\] \d{4}-"; then record V2.10 "$CMD_LABEL" PASS ""
  else record V2.10 "$CMD_LABEL" FAIL ""; fi
else
  record V2.9 "MDX north star" SKIP "no session"
  record V2.10 "signals-only MDX" SKIP "no session"
fi

CMD_LABEL="notify.test.ts"
if bun test src/tradingview/lib/notify.test.ts 2>&1 | tail -3 | rg -q "0 fail"; then record V2.11 "$CMD_LABEL" PASS ""
else record V2.11 "$CMD_LABEL" FAIL ""; fi

CMD_LABEL="quotes regression"
timeout 20 bun run src/tradingview/index.ts quotes NASDAQ:AAPL > /tmp/tv-verify-V2.12q.log 2>&1; EC=$?
if [[ $EC -eq 124 ]] && rg -qi "AAPL" /tmp/tv-verify-V2.12q.log; then record V2.12 "$CMD_LABEL" PASS ""
else record V2.12 "$CMD_LABEL" FAIL "exit=$EC"; fi

if [[ $HAS_SESSION -eq 1 ]]; then
  timeout 30 bun run src/tradingview/index.ts alerts --list-only > /tmp/tv-verify-V2.12a.log 2>&1; EC=$?
  if [[ $EC -eq 0 ]]; then record V2.12-auth "alerts --list-only" PASS ""
  else record V2.12-auth "alerts --list-only" FAIL "exit=$EC"; fi
else record V2.12-auth "alerts --list-only" SKIP "no session"; fi

echo "=== V3 Charts ==="
if [[ $HAS_SESSION -eq 1 ]]; then
  timeout 30 bun run src/tradingview/index.ts charts > /tmp/tv-verify-V3.1.log 2>&1; EC=$?
  if [[ $EC -eq 0 ]] && rg -q "." /tmp/tv-verify-V3.1.log; then
    record V3.1 "charts list" PASS ""
    ID=$(rg -o '^[A-Za-z0-9_-]{6,}' /tmp/tv-verify-V3.1.log | head -1 || true)
    if [[ -n "$ID" ]]; then
      timeout 30 bun run src/tradingview/index.ts charts "$ID" > /tmp/tv-verify-V3.2.log 2>&1; EC2=$?
      if [[ $EC2 -eq 0 ]]; then record V3.2 "charts detail" PASS "id=$ID"
      else record V3.2 "charts detail" FAIL "exit=$EC2"; fi
      timeout 90 bun run src/tradingview/index.ts indicator --from-chart "$ID" BYBIT:BTCUSDT.P --once > /tmp/tv-verify-V3.3.log 2>&1; EC3=$?
      if [[ $EC3 -eq 0 ]]; then record V3.3 "--from-chart" PASS ""
      else record V3.3 "--from-chart" FAIL "exit=$EC3"; fi
    else
      record V3.2 "charts detail" FAIL "no id"
      record V3.3 "--from-chart" SKIP "no layout id"
    fi
  else record V3.1 "charts list" FAIL "exit=$EC"; record V3.2 "charts detail" SKIP ""; record V3.3 "--from-chart" SKIP ""; fi
else
  record V3.1 "charts list" SKIP "no session"
  record V3.2 "charts detail" SKIP "no session"
  record V3.3 "--from-chart" SKIP "no session"
fi

CMD_LABEL="spec/from-chart mutual exclusion"
OUT=$(bun run src/tradingview/index.ts indicator rsi --from-chart X NASDAQ:AAPL --once 2>&1); EC=$?
if [[ $EC -ne 0 ]] && echo "$OUT" | rg -qi "either"; then record V3.4 "$CMD_LABEL" PASS ""
else record V3.4 "$CMD_LABEL" FAIL "exit=$EC"; fi

echo "=== V4 Indicators lib ==="
CMD_LABEL="indicators rsi"
timeout 30 bun run src/tradingview/index.ts indicators rsi > /tmp/tv-verify-V4.1.log 2>&1; EC=$?
if [[ $EC -eq 0 ]] && rg -q "STD;" /tmp/tv-verify-V4.1.log && rg -qi "Relative Strength" /tmp/tv-verify-V4.1.log; then record V4.1 "$CMD_LABEL" PASS ""
else record V4.1 "$CMD_LABEL" FAIL "exit=$EC"; fi

if [[ $HAS_SESSION -eq 1 ]]; then
  timeout 30 bun run src/tradingview/index.ts indicators --filter saved > /tmp/tv-verify-V4.2.log 2>&1; EC=$?
  if [[ $EC -eq 0 ]]; then record V4.2 "indicators --filter saved" PASS ""
  else record V4.2 "indicators --filter saved" FAIL "exit=$EC"; fi
else record V4.2 "indicators --filter saved" SKIP "no session"; fi

if ls ~/.genesis-tools/tradingview/cache/ 2>/dev/null | rg -q .; then record V4.3 "cache dir" PASS ""
else record V4.3 "cache dir" FAIL ""; fi

echo "=== V5 Scan ==="
CMD_LABEL="scan two symbols"
timeout 30 bun run src/tradingview/index.ts scan rsi,rating --symbols NASDAQ:AAPL,NASDAQ:MSFT > /tmp/tv-verify-V5.1.log 2>&1; EC=$?
ROWS=$(rg -c "NASDAQ:" /tmp/tv-verify-V5.1.log || true)
if [[ $EC -eq 0 && $ROWS -eq 2 ]]; then record V5.1 "$CMD_LABEL" PASS ""
else record V5.1 "$CMD_LABEL" FAIL "exit=$EC rows=$ROWS"; fi

CMD_LABEL="scan --json"
if timeout 30 bun run src/tradingview/index.ts scan rsi --symbols NASDAQ:AAPL --json 2>/dev/null | bun -e 'const x=JSON.parse(await Bun.stdin.text()); if(!Array.isArray(x)||!x[0].symbol) throw new Error("bad")'; then
  record V5.2 "$CMD_LABEL" PASS ""
else record V5.2 "$CMD_LABEL" FAIL ""; fi

CMD_LABEL="bad symbol"
OUT=$(timeout 30 bun run src/tradingview/index.ts scan rsi --symbols NASDAQ:APPL 2>&1)
if echo "$OUT" | rg -qi "error|no such|not found|empty" && ! echo "$OUT" | rg -q "Unhandled"; then record V5.3 "$CMD_LABEL" PASS ""
else record V5.3 "$CMD_LABEL" FAIL ""; fi

echo "=== V6 Final ==="
# V6.1 re-run V1 subset
if bun test src/tradingview 2>&1 | tail -3 | rg -q "0 fail" && ! tsgo --noEmit 2>&1 | rg -q "src/tradingview"; then record V6.1 "re-run V1" PASS ""
else record V6.1 "re-run V1" FAIL ""; fi

COMMITS=$(git log --oneline master..feat/tradingview 2>/dev/null | wc -l | tr -d ' ')
if [[ $COMMITS -gt 0 ]]; then record V6.2 "commit history" PASS "$COMMITS commits"
else record V6.2 "commit history" FAIL ""; fi

if bun run src/tradingview/index.ts --help 2>&1 | rg -q "indicator" && bun run src/tradingview/index.ts --help 2>&1 | rg -q "charts" && bun run src/tradingview/index.ts --help 2>&1 | rg -q "scan" && bun run src/tradingview/index.ts --help 2>&1 | rg -q "indicators"; then
  record V6.3 "help six commands" PASS ""
else record V6.3 "help six commands" FAIL ""; fi

CNT=$(rg -c "indicator|charts|scan" src/tradingview/README.md 2>/dev/null || echo 0)
if [[ $CNT -ge 6 ]]; then record V6.4 "README" PASS "matches=$CNT"
else record V6.4 "README" FAIL "matches=$CNT"; fi

echo ""
echo "## Verification Results"
echo "| check id | command | PASS/FAIL | note |"
for r in "${RESULTS[@]}"; do echo "$r"; done

FAILS=$(printf '%s\n' "${RESULTS[@]}" | rg -c " FAIL " || true)
SKIPS=$(printf '%s\n' "${RESULTS[@]}" | rg -c " SKIP " || true)
if [[ $FAILS -eq 0 ]]; then
  if [[ $SKIPS -gt 0 ]]; then echo ""; echo "**Overall: GREEN-with-SKIPs** ($SKIPS skipped)"; else echo ""; echo "**Overall: GREEN**"; fi
else echo ""; echo "**Overall: RED** — failing checks: $(printf '%s\n' "${RESULTS[@]}" | rg " FAIL " | sed 's/.*| //')"; fi