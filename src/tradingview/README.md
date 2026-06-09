# tradingview

Stream TradingView live quotes, price alerts, indicator values/signals, saved-chart inventory, and multi-symbol scans.

| Command | Auth | Description |
|---------|------|-------------|
| `quotes` | optional | Live quote feed per symbol |
| `alerts` | required | List alerts + stream fires |
| `indicator` | optional* | Indicator values + shape marks (history → live) |
| `charts` | required | Saved layout list or study inventory |
| `indicators` | optional | Search/list indicator library |
| `scan` | guest | Multi-symbol scanner columns |

\* Community scripts (`PUB;*`) need a session cookie for reliable translate/attach; built-ins (`STD;*`) work as guest.

## Usage

```bash
tools tradingview quotes NASDAQ:AAPL OANDA:SPX500USD
tools tradingview alerts --list-only
tools tradingview indicator rsi NASDAQ:AAPL --once
tools tradingview indicator "PUB;AGFHDbJ2" BYBIT:BTCUSDT.P --tf 15
tools tradingview charts
tools tradingview indicators rsi
tools tradingview scan rsi,rating --symbols NASDAQ:AAPL,NASDAQ:MSFT
```

## Quotes

`quotes <symbols...>` opens TradingView's market-data WebSocket and prints a
live, color-coded line per symbol (price, absolute change, percent change,
volume). Works as **guest** with no login — guest data is realtime where the
exchange allows it, delayed otherwise.

Pass `--auth` to use your logged-in session (`prodata` host) for full realtime
data on your plan's entitlements.

## Alerts

`alerts` lists your existing price alerts, then subscribes to the live push
feed and prints a banner whenever an alert **fires**, plus create/update events.
Requires a logged-in session.

## indicator

`indicator` attaches a Pine study to a chart session, prints a history table,
then keeps streaming live values and interpreted shape marks (buy/sell arrows,
diamonds, etc.).

**Spec forms:** alias (`rsi`), `STD;RSI`, `PUB;AGFHDbJ2`, or a `tradingview.com/script/...` URL.

| Flag | Purpose |
|------|---------|
| `--tf` | Resolution (`1`, `15`, `60`, `1D`, …) |
| `--bars` | History depth (default 300) |
| `--input Length=21` | Override study inputs (repeatable) |
| `--once` | Snapshot only, then exit |
| `--signals-only` | Hide numeric rows; show marks only |
| `--json` | NDJSON on stdout (`point` / `signal` objects) |
| `--notify` | `tools say` + macOS banner on live signals |
| `--exec <cmd>` | Shell hook; signal JSON in `$TV_SIGNAL` |
| `--from-chart <id>` | Attach up to 5 studies from a saved layout |

Examples:

```bash
# Built-in RSI, daily snapshot
tools tradingview indicator rsi NASDAQ:AAPL --once

# MDX community script, 15m, voice on live signals
tools tradingview indicator "PUB;AGFHDbJ2" BYBIT:BTCUSDT.P --tf 15 --notify

# Pipe NDJSON into jq
tools tradingview indicator rsi NASDAQ:AAPL --once --json 2>/dev/null | jq -c 'select(.type=="signal")'

# Replay every study on a saved layout
tools tradingview indicator --from-chart YLjdL7wq BYBIT:BTCUSDT.P --once
```

## charts

`charts` lists saved layouts (id, name, symbol, resolution). Pass a layout id to
print each attached study and its saved inputs.

```bash
tools tradingview charts
tools tradingview charts YLjdL7wq
```

## indicators

`indicators` searches the pine-facade library. Default filter is built-in
`standard`; use `--filter saved` or `--filter favorites` for account scripts.

```bash
tools tradingview indicators rsi
tools tradingview indicators --filter saved
```

## scan

`scan` runs TradingView's scanner API across multiple symbols in one request.
Pass aliases (`rsi`, `rating`, `macd`) or raw scanner column tokens.

```bash
tools tradingview scan rsi,rating --symbols NASDAQ:AAPL,NASDAQ:MSFT
tools tradingview scan rsi --symbols NASDAQ:AAPL --json
```

## Providing a session

Set one of:

- `TRADINGVIEW_COOKIE="sessionid=...; sessionid_sign=..."` plus
  `TRADINGVIEW_USERNAME` and `TRADINGVIEW_USER_ID`, or
- `TRADINGVIEW_SESSIONID` + `TRADINGVIEW_SESSIONID_SIGN` + `TRADINGVIEW_USERNAME` + `TRADINGVIEW_USER_ID`, or
- `--cookie "<cookie string>"` on the command.

Grab `sessionid` / `sessionid_sign` from your browser's TradingView cookies
(DevTools → Application → Cookies → tradingview.com).

## Protocol notes

See `.claude/plans/2026-06-09-TradingViewTool.md` for the full reverse-engineered
protocol reference (frame framing, heartbeat, quote session lifecycle, alert
REST endpoints, and the push-feed event shapes).

Indicator/chart protocol details: `.claude/plans/2026-06-09-TradingViewIndicators.md`.