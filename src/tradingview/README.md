# tradingview

Stream TradingView's live quote feed and price-alert feed to your terminal.

## Usage

    tools tradingview quotes NASDAQ:AAPL OANDA:SPX500USD
    tools tradingview alerts
    tools tradingview alerts --list-only

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

### Providing a session

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