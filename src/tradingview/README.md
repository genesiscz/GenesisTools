# tools tradingview

Stream TradingView market data in the terminal: live quotes, your price alerts, indicator values and signal marks,
your saved chart layouts, and one scan across many symbols. Use it to watch a market or an indicator without a
browser, or to feed indicator signals into a script. It talks to TradingView's own unofficial endpoints, so it needs
no API key. Some commands need the session cookie of your logged-in browser.

## Quick start

```bash
tools tradingview quotes NASDAQ:AAPL OANDA:SPX500USD                 # live quote lines as guest, Ctrl-C to stop
tools tradingview scan rsi,rating --symbols NASDAQ:AAPL,NASDAQ:MSFT  # one scanner table, then exit
tools tradingview indicator rsi NASDAQ:AAPL --once                   # daily RSI history table, then exit
tools tradingview indicators bollinger                               # find a built-in indicator and its id
tools tradingview alerts --list-only                                 # your price alerts (needs a session)
tools tradingview charts                                             # your saved chart layouts (needs a session)
```

A symbol is always `EXCHANGE:TICKER`, for example `NASDAQ:AAPL` or `BYBIT:BTCUSDT.P`. `quotes` and `indicator`
uppercase it. `scan` sends it as you typed it.

## Commands

| Command                     | Session    | What it does                                           |
|-----------------------------|------------|--------------------------------------------------------|
| `quotes <symbols...>`       | optional   | Stream a live quote line per symbol                    |
| `alerts`                    | required   | List your price alerts, then stream fires and edits    |
| `indicator [spec] [symbol]` | optional * | Indicator values and signal marks: history, then live  |
| `charts [layoutId]`         | required   | List saved layouts, or the studies on one layout       |
| `indicators [query]`        | optional * | Search the indicator library                           |
| `scan <indicators>`         | never      | Scanner columns for many symbols in one request        |

\* Built-in scripts (`STD;...`) work as guest. Community scripts (`PUB;...`) need a session cookie to translate and
attach reliably. `indicator --from-chart`, `indicators --filter saved` and `indicators --filter favorites` always
need a session.

Every command except `scan` takes `--cookie "<cookie string>"` for a one-off session. `quotes` reads it only
together with `--auth`. The tool also takes `-v, --verbose` (debug logging; this tool's debug messages start with
`tradingview:`) and `--readme`. How to provide a session is in [Configuration](#configuration).

### quotes

```bash
tools tradingview quotes [--auth] [--cookie <cookie>] <symbols...>
```

Opens TradingView's market-data WebSocket and prints a live, color-coded line per symbol each time it changes:
price, absolute change, percent change and volume. It works as guest with no login. Guest data is realtime where the
exchange allows it, and delayed otherwise.

| Flag                | Default | Meaning                                                   |
|---------------------|---------|-----------------------------------------------------------|
| `--auth`            | off     | Use your session (`prodata` host) instead of guest data   |
| `--cookie <cookie>` |         | Session cookie for this run, read only with `--auth`      |

`--auth` gives full realtime data on your plan's entitlements. Without a session it warns
`No session found; falling back to guest data.` and streams as guest. Without `--auth` the command never looks for a
session: it ignores `--cookie`, the environment variables and `config.json`, and streams guest data with no warning.
So pass both for a one-off session:

```bash
tools tradingview quotes --auth --cookie "sessionid=<value>; sessionid_sign=<value>" NASDAQ:AAPL
```

An unknown symbol prints `✗ <symbol>: no such symbol (check the EXCHANGE:TICKER spelling)`, and the other symbols
keep streaming. The quote stream does not reconnect: when TradingView closes the socket, the tool prints
`Connection closed.` and you start it again.

### alerts

```bash
tools tradingview alerts [--list-only] [--cookie <cookie>]
```

Lists your price alerts, one row each: `●` active or `○` inactive, the alert id, the symbol, the condition (its type
and target value) and your alert message. Then it subscribes to your private push feed and prints:

- a yellow `ALERT` banner with the local time, the symbol and the message when an alert fires,
- a green `+ created` line when you create an alert,
- a cyan `~ updated` line when an alert changes, with `active` or `inactive` and the stop reason.

`--list-only` prints the list and exits. Without a session the command exits 1 and names the environment variables
and the config file it looked at. Like `quotes`, the push feed does not reconnect: it prints `Feed closed.`.

### indicator

```bash
tools tradingview indicator <spec> <symbol> [options]
tools tradingview indicator --from-chart <layoutId> <symbol> [options]
```

Attaches a Pine study to a headless chart session on TradingView's servers. It prints the history as a table, then
keeps streaming live values and signal marks (buy and sell arrows, diamonds, labels). TradingView runs the script,
so this also works for a protected community script whose source you cannot read.

**Spec forms:**

| Spec       | Example                               | How it resolves                    |
|------------|---------------------------------------|------------------------------------|
| Alias      | `rsi`                                 | Alias table, then built-in library |
| Name       | `"Bollinger Bands"`                   | Exact name, or the only name match |
| Script id  | `STD;RSI`, `PUB;aBcD1234`, `USER;...` | Used as given                      |
| Script URL | see below                             | Becomes `PUB;<slug>`               |

A script URL looks like `https://www.tradingview.com/script/aBcD1234-My-Script/` and becomes `PUB;aBcD1234`.

The aliases are `rsi` (Relative Strength Index), `macd`, `ema` (Moving Average Exponential), `sma` (Moving Average
Simple), `bb` (Bollinger Bands), `vwap`, `atr` (Average True Range), `stoch` (Stochastic), `supertrend`, `adx`
(Average Directional Index) and `obv` (On Balance Volume). A name matches the built-in library only. A text that
matches no name, or more than one, stops with `Unknown indicator`; search with `tools tradingview indicators <text>`
and pass the id.

A community script's URL carries a short publication slug (the part before the first `-`). That slug is not the id
TradingView's translate call wants, so the tool looks up the internal id through the script search, then the script
page.

| Flag                      | Default | Meaning                                                   |
|---------------------------|---------|-----------------------------------------------------------|
| `--tf <resolution>`       | `1D`    | Timeframe: `1`, `5`, `15`, `60`, `240`, `1D`, `1W`, ...   |
| `--bars <n>`              | `300`   | History bars to load and print                            |
| `--input <name=value...>` | none    | Override study inputs (repeatable)                        |
| `--from-chart <layoutId>` |         | Attach the script studies of a saved layout (first 5)     |
| `--once`                  | off     | Print the history snapshot, then exit                     |
| `--signals-only`          | off     | Text output only: hide the numeric rows                   |
| `--json`                  | off     | NDJSON on stdout (`point` and `signal` objects)           |
| `--notify`                | off     | Speak each live signal with `tools say`                   |
| `--exec <cmd>`            |         | Run a shell command on each live signal                   |
| `--cookie <cookie>`       |         | Session cookie for this run                               |

`--signals-only` changes the text output only. With `--json` every `point` object still goes to stdout, so filter
with `jq 'select(.type=="signal")'` instead.

**Inputs.** `--input` matches a study input by its name or its id (`in_0`, `in_1`, ...), case-insensitive. The value
becomes the input's type: integer, float, bool (`true` or `1` is true) or text. An unknown name stops with
`Unknown input "<name>". Available inputs: ...`. That list is the quickest way to see the names you can set.

Only inputs that TradingView's translate call returns without the `isFake` flag can be set. The tool drops every
flagged input, and every hidden one, from the study ([lib/pine-facade.ts](lib/pine-facade.ts)). The built-in RSI
(`STD;RSI`) has all its user inputs flagged, so it has no input you can set: any `--input` on `rsi` stops with
`Unknown input "<name>". Available inputs: ` and an empty list, and RSI always runs with its defaults. An empty list
means the same for any other script.

`--input` takes several values, so it swallows the words after it. Put the spec and the symbol first:
`indicator "PUB;aBcD1234" NASDAQ:AAPL --input "Length=21"`. In
`indicator "PUB;aBcD1234" --input "Length=21" NASDAQ:AAPL` the symbol becomes an input value and the command stops
with `Symbol is required`.

**Saved layouts.** `--from-chart <layoutId>` takes no spec: the lone positional is the symbol. A spec and a symbol
together with `--from-chart` stop with `Provide either an indicator spec or --from-chart, not both.` The tool reads
the layout, keeps its studies that carry a script id, and attaches the first 5 that translate. Each study gets its
saved inputs, but only for the inputs that the translate call does not flag (see Inputs). A study whose inputs are
all flagged, such as RSI, runs with its defaults and not with the values saved on the layout. A built-in study that
is not a Pine script (Volume Profile, for example) has no translate body and is skipped with
`not attachable headlessly`. Here `--input` changes the input on every attached study that has it and skips the
others without an error. Get layout ids from `tools tradingview charts`.

**Session and host.** With any session (flag, environment or config file) the indicator uses the `prodata` host and
your auth token. Without one it uses guest data, and warns when a community script is attached.

**Output.** A header row names the plots. Each row is a bar time in UTC (`YYYY-MM-DD HH:MM`) and one column per plot.
Values of plots that are not lines show in yellow when set. Signal lines carry `[hist]` for a mark in the history and
a yellow `SIGNAL` tag for a live one. After every study has printed its history, a `live` marker line follows.

**Signals.** A signal is a value on a plot of type `shapes`, `chars` or `arrows`. Each plot fires at most once per
bar. Only live signals run `--notify` and `--exec`; marks in the history never do. The arrow is a guess from the plot
title: `▼` when the title contains sell, down or short, else `▲`. So a plot titled "Regular Bearish Label" shows
`▲`. RSI's shape plots are its divergence labels. Its `Calculate Divergence` input is off by default and cannot be
set (see Inputs), so the tool cannot turn these labels on.

- `--notify` runs `tools say "<TICKER> <plot title> signal" --app tradingview`, for example "AAPL Buy signal". The
  voice comes from the `tradingview` profile of `tools say`. It speaks only: there is no macOS banner.
- `--exec <cmd>` runs the command with `sh -c` and puts the signal in `$TV_SIGNAL` as JSON. The command's own
  output is discarded, so redirect it inside the command. A `$TV_SIGNAL` value:

```json
{"time":1767225600,"barIndex":299,"plotId":"plot_1","plotTitle":"Buy","value":1,"kind":"live","symbol":"NASDAQ:AAPL"}
```

**Reconnect.** In live mode the chart socket reconnects by itself. It waits 1 s, 2 s, 4 s and so on up to 30 s, and
fetches a fresh auth token first when a session exists. `--once` never reconnects. A study error or an unknown symbol
ends the command with exit 1.

```bash
# Built-in RSI, daily history, then exit
tools tradingview indicator rsi NASDAQ:AAPL --once

# A community script with its "Length" input set to 21, on 15-minute bars, then stream
tools tradingview indicator "PUB;aBcD1234" NASDAQ:AAPL --tf 15 --input "Length=21"

# A community script on 15-minute bars, live signals spoken
tools tradingview indicator "PUB;aBcD1234" BYBIT:BTCUSDT.P --tf 15 --notify

# Only the signal objects of the history, through jq (--signals-only does not filter --json)
tools tradingview indicator "PUB;aBcD1234" NASDAQ:AAPL --once --json 2>/dev/null \
    | jq -c 'select(.type=="signal")'

# Append every live signal to a file
tools tradingview indicator "PUB;aBcD1234" BYBIT:BTCUSDT.P \
    --tf 15 \
    --signals-only \
    --exec 'printf "%s\n" "$TV_SIGNAL" >> ~/tv-signals.ndjson'

# Every script study on a saved layout, history only
tools tradingview indicator --from-chart Ab12Cd34 BYBIT:BTCUSDT.P --once
```

### charts

```bash
tools tradingview charts [layoutId] [--cookie <cookie>]
```

Without an id it lists up to 100 saved layouts: the id, name, symbol, resolution and last-modified date. The last
column always shows a dash and the word `studies`, because the layout list does not carry a study count. Run
`charts <layoutId>` to see the studies. With an id
it prints each study on the layout: its name, its script id and version, and its saved inputs (`in_0=...`), or
`(defaults)` when it has none. Use the ids with `indicator --from-chart`. Needs a session.

```bash
tools tradingview charts             # all saved layouts
tools tradingview charts Ab12Cd34    # the studies and inputs on one layout
```

### indicators

```bash
tools tradingview indicators [query] [--filter standard|saved|favorites] [--cookie <cookie>]
```

Lists TradingView's indicator library with the script id, the name and the version. `query` keeps the rows whose
name or id contains the text, case-insensitive.

| `--filter`   | Lists                          | Session  |
|--------------|--------------------------------|----------|
| `standard`   | Built-in scripts (the default) | no       |
| `saved`      | Your own saved scripts         | required |
| `favorites`  | Your favorite scripts          | required |

The `standard` list is cached for 24 hours. `saved` and `favorites` are fetched on every run.

```bash
tools tradingview indicators rsi
tools tradingview indicators --filter saved
```

### scan

```bash
tools tradingview scan <indicators> --symbols <list> [--json]
```

Runs TradingView's scanner API for all symbols in one request and prints a table. `--symbols` is required and takes
a comma-separated list. `close` is always the first column. `scan` never uses a session.

| Alias    | Scanner columns            |
|----------|----------------------------|
| `rsi`    | `RSI`, `RSI[1]`            |
| `macd`   | `MACD.macd`, `MACD.signal` |
| `stoch`  | `Stoch.K`, `Stoch.D`       |
| `adx`    | `ADX`                      |
| `atr`    | `ATR`                      |
| `ema50`  | `EMA50`                    |
| `ema200` | `EMA200`                   |
| `sma50`  | `SMA50`                    |
| `rating` | `Recommend.All`            |

Any other word is sent as a raw scanner column name, as typed. A missing value prints as a dash (`null` in JSON).
A symbol the scanner does not return prints `✗ <symbol>: not found by the scanner (check the EXCHANGE:TICKER
spelling)`. When no symbol comes back at all, the command exits 1.

```bash
tools tradingview scan rsi,rating --symbols NASDAQ:AAPL,NASDAQ:MSFT
tools tradingview scan rsi --symbols NASDAQ:AAPL --json
```

## How it works

The endpoints are TradingView's own, unofficial and reverse-engineered. A change on TradingView's side can break a
command.

| Command                   | Endpoint (all on `tradingview.com`)                    |
|---------------------------|--------------------------------------------------------|
| `quotes`, `indicator`     | Socket `data.` (guest) or `prodata.`                   |
| `alerts`                  | `pricealerts.`, push feed `pushstream.`                |
| `indicator`, `indicators` | `pine-facade.` (library list, script translate)        |
| `indicator` (`PUB;` slug) | `www.` script search and script page                   |
| `charts`, `--from-chart`  | `www.` `/my-charts/` and `/chart/<id>/json/`           |
| `scan`                    | `POST scanner./global/scan`                            |

The `quotes` and `indicator` socket and the alerts push feed are WebSockets. The other endpoints are HTTPS calls.

- **Auth token.** A guest socket sends the token `unauthorized_user_token`. With a session, the tool reads the
  `auth_token` from the TradingView home page with your cookie. When the page has none (an expired cookie), it falls
  back to the guest token without an error.
- **Files.** `~/.genesis-tools/tradingview/config.json` holds an optional saved session (see
  [Configuration](#configuration)). `~/.genesis-tools/tradingview/cache/standard-scripts` caches the built-in
  library list for 24 hours.
- **Output streams.** Human output goes to stderr. `--json` output goes to stdout, so `2>/dev/null` leaves only JSON.
- **Times.** The indicator table prints bar times in UTC. Alert fires print your local time.
- **On the Mac.** It needs network access and no macOS permissions. `--notify` needs `tools say`.
- **Cost.** Nothing here costs money. Which data is realtime depends on your TradingView plan.

## Configuration

A session is your TradingView login cookie. The tool takes the first one it finds, in this order:

1. `--cookie "<cookie string>"` on the command.
2. `TRADINGVIEW_COOKIE`.
3. `TRADINGVIEW_SESSIONID` plus `TRADINGVIEW_SESSIONID_SIGN`, joined into `sessionid=...; sessionid_sign=...`.
4. `session` in `~/.genesis-tools/tradingview/config.json`.

| Variable                     | Meaning                                          |
|------------------------------|--------------------------------------------------|
| `TRADINGVIEW_COOKIE`         | Full cookie: `sessionid=...; sessionid_sign=...` |
| `TRADINGVIEW_SESSIONID`      | The `sessionid` cookie value                     |
| `TRADINGVIEW_SESSIONID_SIGN` | The `sessionid_sign` cookie value                |
| `TRADINGVIEW_USERNAME`       | Your TradingView username (optional)             |
| `TRADINGVIEW_USER_ID`        | Your numeric user id (optional)                  |

With a cookie from the flag or the environment, a missing username or user id is read from the TradingView home
page. The alerts list request sends both.

To get the cookie, log in on tradingview.com in your browser. Open DevTools, then the Application tab, then Cookies,
then `https://www.tradingview.com`, and copy the values of `sessionid` and `sessionid_sign`.

```bash
export TRADINGVIEW_SESSIONID="<sessionid value>"
export TRADINGVIEW_SESSIONID_SIGN="<sessionid_sign value>"
tools tradingview alerts --list-only
```

No command writes the config file. To keep a session there, create it by hand:

```json
{
    "session": {
        "username": "alice",
        "userId": 12345678,
        "cookie": "sessionid=<value>; sessionid_sign=<value>"
    }
}
```

The tool uses this session as written, with no home-page lookup, so give it `username` and `userId` for `alerts`.
The cookie is a full login to your account. Keep the file private:
`chmod 600 ~/.genesis-tools/tradingview/config.json`.

## For agents

- `indicator --json` prints one JSON object per line on stdout, a `point` or a `signal`. Use `--once` for a bounded
  run; without it the stream runs until it is stopped. `values` has one entry per plot of the study, in plot order,
  `time` is Unix seconds, and a signal's `kind` is `history` or `live`. `--signals-only` does not filter this output.

```text
{"type":"point","symbol":"NASDAQ:AAPL","study":"My Script","barIndex":299,"time":1767225600,"values":[48.2,null]}
{"type":"signal","symbol":"NASDAQ:AAPL","study":"My Script","time":1767225600,"barIndex":299,"plotId":"plot_1",
 "plotTitle":"Buy","value":1,"kind":"history"}
```

The example study has two plots: a line and a `Buy` shapes plot. Colorer and alertcondition plots also take a place
in `values`. The built-in RSI, for example, has 14 plots, and each of its points carries 14 values. The header row
of a text run names every plot in that order, so use it to map an index to a plot.

The signal object is one line in the real output; it is wrapped here to fit. Signals in the history print while the
history loads, and the history points print when the study finishes, so those signals come before their points.
Sort by `barIndex` when the order matters.

- `scan --json` prints one JSON array on stdout, with `null` for a missing value:
  `[{"symbol":"NASDAQ:AAPL","close":180.5,"RSI":55.1,"RSI[1]":54.2}]`.
- `quotes`, `alerts`, `charts` and `indicators` print text only.
- Exit codes: 0 on success and after `--once`. 1 on an error: no session where one is needed, an unknown indicator
  or input, a bad `--input` value, a study error, an unknown symbol in `indicator`, or no symbol found by `scan`.
  Ctrl-C on a stream also exits 0: `quotes`, `alerts` and `indicator` catch it, close the socket and exit cleanly.
- `tools hub watching` reads your alerts through the same session lookup and lists them beside your other watches.
- The tool has no MCP tool and no plugin skill.

## Troubleshooting

- **`no such symbol (check the EXCHANGE:TICKER spelling)`.** The symbol needs its exchange prefix. Copy the exact
  `EXCHANGE:TICKER` from the symbol's TradingView page.
- **`Unknown indicator "<spec>"`.** The alias or name matched no built-in script, or more than one. Search with
  `tools tradingview indicators <text>` and pass the script id.
- **`Symbol is required` although you gave a symbol.** `--input` swallowed it. Put the spec and the symbol before
  `--input`.
- **`Unknown input "<name>"`.** Use one of the names the error lists, or the `in_N` id. When the list after
  `Available inputs:` is empty, the script has no input you can set (the translate call flags them all `isFake`, as
  for the built-in RSI). Run it without `--input`.
- **`--input "<flag>": expected name=value`.** The `--input` value has no `=`, or nothing before it. Write it as
  `--input "Length=21"`.
- **`"<value>" is not a valid integer` or `"<value>" is not a valid number`.** The input is an integer or a float,
  and the value is not one. Pass a number, for example `--input "Length=21"`.
- **`Provide either an indicator spec or --from-chart, not both.`** You gave a spec, a symbol and `--from-chart`.
  With `--from-chart`, pass only the symbol.
- **A warning that community scripts usually need a session.** You run a `PUB;` script as guest. Provide a session.
- **`Could not resolve publication slug PUB;<slug> to an internal script id`.** Neither the script search nor the
  script page gave the internal id. Check the slug against the script's URL, and try again with a session: both
  requests then carry your cookie.
- **`Skipping "<name>" (<id>): not attachable headlessly.`** A built-in layout study that is not a Pine script. The
  other studies still attach.
- **`Layout has N studies; attaching the first 5 that translate.`** `--from-chart` attaches 5 studies at most.
- **`alerts` prints `0 alert(s)` although you have alerts.** TradingView did not answer the list call with `ok`; the
  tool logs `tradingview: list_alerts non-ok`. Check that the cookie is current and that the session has your
  username and user id.
- **Data looks delayed although a session is set.** The home page showed no `auth_token` for your cookie, so the
  tool used guest data. `-v` logs `auth_token not found in homepage, falling back to guest`. Copy fresh cookies.
- **The stream stopped with `Connection closed.` or `Feed closed.`** `quotes` and `alerts` do not reconnect. Run the
  command again. `indicator` reconnects by itself.

## Protocol notes

The full reverse-engineered protocol reference (message framing, heartbeat, quote session lifecycle, alert REST
endpoints, push-feed event shapes, and the indicator and chart protocol) is in the tool's design notes, which are not
published. What the code relies on:

- Frames are `~m~<length>~m~<payload>`, and a heartbeat `~h~<n>` must be echoed back
  ([lib/protocol.ts](lib/protocol.ts)).
- The tool uses Bun's native WebSocket on purpose. The `ws` package's Bun shim drops the `Origin` and `User-Agent`
  headers, and TradingView then rejects the handshake with close code 1002 ([lib/ws.ts](lib/ws.ts)).
- `is_auth_to_get` only says whether your account may read a script's source. It is not an execution gate: a
  protected community script answers false there and still translates and runs through `create_study` (verified
  2026-06-10). A successful translate is the real check ([lib/pine-facade.ts](lib/pine-facade.ts)).
- A `PUB;` publication slug resolves to an internal id for translate, and `create_study` gets the slug back.
- Where each part lives: [lib/quote-client.ts](lib/quote-client.ts) (quotes),
  [lib/chart-client.ts](lib/chart-client.ts) (chart and study sessions), [lib/alerts-rest.ts](lib/alerts-rest.ts) and
  [lib/alerts-feed.ts](lib/alerts-feed.ts) (alerts), [lib/charts-storage.ts](lib/charts-storage.ts) (layouts),
  [lib/scanner.ts](lib/scanner.ts) (scan), [lib/signals.ts](lib/signals.ts) (signal marks).
- `lib/alerts-rest.ts` also has calls to create alerts, delete alerts and read recent fires. No command uses them yet.

## Related

- [`tools hub`](../hub/README.md): `tools hub watching` lists your TradingView alerts beside your other watches.
- [`tools say`](../say/README.md): the voice behind `--notify`. Set it with
  `tools say --app tradingview --voice <name> --save`.
