# Chrome DevTools arm: CPU leak, duplicate processes, what we found

Date: 2026-08-25 to 2026-08-26
Host: Martin's Mac (macOS 26.3.1, Bun 1.3.13)
Skill: `~/.agents/skills/chrome-devtools/` (since ported to `tools chrome-devtools`)

**2026-08-26 14:30 — this document is now history, kept as the "why".** The skill became
`src/chrome-devtools/` in GenesisTools. The port keeps every fix from section 7 and goes
further: `arm` is now `record`, the unbounded jsonl became rotating 30-minute segments with
a 4-hour window, pidfiles carry process identity (command + start time) via
`@genesiscz/utils/process/pidfile`, and `dataReceived` is aggregated through a regex fast
path instead of being dropped entirely (HAR sizes stay correct at near-zero parse cost).
Section 9's checklist was executed in that port; the contract table at the end still holds,
with `arm` read as `record`.

The arm is a background Bun process that attaches to a Chromium browser over the Chrome DevTools Protocol (CDP), turns on `Network.enable` on http(s) tabs, and appends metadata events to `/tmp/cdp-arm-<port>.jsonl` so `har` can dump "attach until now" later. It is not `chrome-devtools-mcp`. It is `bun chrome-devtools.ts arm --port N`.

---

## 1. What the user saw

Activity Monitor showed two hot PIDs:

| PID | Status when inspected | Command |
|---|---|---|
| **49166** | Already gone | Never recovered. Close in number to 49862, likely a sibling recorder or the parent `attach` that spawned the arm and exited. |
| **49862** | Alive, 50-80% CPU for 4.5 hours | `bun /Users/Martin/.agents/skills/chrome-devtools/scripts/chrome-devtools.ts arm --port 9222` |

A third recorder was the same class of leftover, not this skill:

| PID | Command |
|---|---|
| **96932** | `bun scripts/per-target-record.ts --target 186BBA31073525576BED85533107F2C5 --label run5-tabA --port 9222` (GenesisBrain login experiment, same dead port, ~78% CPU, no TCP) |

The user then said: let it arm, but it should not be five processes at high CPU when nothing is happening. Find the leak.

---

## 2. Process 49862, measured

Taken 2026-08-25 ~20:22 local (CEST).

```
PID     PPID  USER    %CPU  RSS     ELAPSED   STAT  COMMAND
49862   1     Martin  50-87 113312  04:29     R     bun chrome-devtools.ts arm --port 9222
```

- **PPID 1** (`launchd`). Orphan. Parent was the `attach` CLI, which `unref()`'d the child and exited.
- Started **Tue Aug 25 15:52:35 2026**.
- **STAT = R** (runnable), not S (sleeping).
- CPU time **3m 15s** over 4h 32m. Live `%CPU` bounced 45-87 on five samples 0.4s apart.
- RSS 113 MB, sample peak 211 MB.
- cwd: `/Users/Martin/Tresors/Projects/CEZ/col-fe`
- stdin/stdout/stderr: `/dev/null` (spawned with all three ignored).
- No children.
- `ps -M`: one hot thread (user 1:34, sys 0:23), rest idle.

### Open files at inspect time (the smoking gun)

`lsof -nP -p 49862` showed **no TCP, no Unix sockets**. Only:

```
cwd, bun binary, dyld, /dev/null x3
KQUEUE  fd 3  count=3  state=0x10
KQUEUE  fd 6  count=0  state=0x10
KQUEUE  fd 7  count=0  state=0x12
```

Port **9222 was not listening**. Chrome was on **9223**. The arm had lost its browser and still ran hot.

`sample 49862 2` spent **1573/1573 samples on the Bun JS main thread**. Not waiting on I/O. Not a syscall. JS was busy.

### The capture file

```
/tmp/cdp-arm-9222.pid     6 bytes   "49862\n"   mtime 15:52
/tmp/cdp-arm-9222.jsonl   635 MB    293,040 lines   mtime 20:20  (frozen)
```

First events: GitLab MR diffs (`gitlab.apps.corp/.../merge_requests/5908`).
Later events: `localhost:3000` col-web chunks, GitLab Sentry envelopes, `muj.cez.cz/col`, Bing UET `bat.bing.com`.

Last 200 KB method mix (252 events):

| method | count |
|---|---|
| Network.dataReceived | 84 |
| Network.loadingFinished | 30 |
| Network.responseReceivedExtraInfo | 28 |
| Network.responseReceived | 28 |
| Network.webSocketFrameReceived | 15 |
| Network.requestWillBeSent | 14 |
| Network.requestWillBeSentExtraInfo | 13 |
| Network.webSocketCreated | 10 |
| Network.webSocketWillSendHandshakeRequest | 10 |
| Network.webSocketFrameError | 10 |
| Network.webSocketClosed | 10 |

The skill called this "metadata only, will not keep response bodies". That was true about bodies. It was **not** cheap. `dataReceived` and websocket **frames** dominated.

---

## 3. What the arm was (architecture)

### How it got started (the old contract)

`bun chrome-devtools.ts attach` listed CDP endpoints on 9222-9230. For every listed port it called `startArmBackground(port)` unless `--no-arm`.

Old spawn (the leaky one):

```ts
const child = Bun.spawn(["bun", script, "arm", "--port", String(port)], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
child.unref();
```

`unref()` means Bun will not keep the parent alive for the child. The parent `process.exit()`s after printing next commands. The child is adopted by `launchd` (PPID 1). Stdio to `/dev/null` means you never see it die.

The child:

1. Wrote `/tmp/cdp-arm-<port>.pid` **after** `connectBrowser` (HTTP `/json/version` then a WebSocket to `webSocketDebuggerUrl`).
2. `Target.setDiscoverTargets` + `Target.setAutoAttach` + `Target.getTargets` + `attachToTarget` for every http(s) **page and iframe**.
3. `Network.enable` on each of those sessions.
4. On every `Network.*` event, `JSON.stringify` + **`appendFileSync`** (open, write, close, every line).
5. Hung forever: `await new Promise(() => {})`.
6. No websocket `close` / `error` handler. No TTL. No `/json/version` health check.

`isArmAlive(port)` was `kill -0` on the pid file. The child wrote that file **after** CDP connect. Until then, the next `attach` saw "no arm" and spawned another.

### What it is for

`har --port N` has no `Network.getHAR`. The arm is the buffer: attach-until-now metadata, dump later. Useful. The bug was the lifetime and the event volume, not the idea.

---

## 4. Hypotheses we tested

### H1. Bun WebSocket busy-loops after the peer dies

This looked true: no TCP, STAT=R, kqueue count=3, 50-80% CPU.

**Repro (Bun 1.3.13):** a real `Bun.serve` websocket (with `upgrade`), flood JSON at 1 ms, then either `server.stop(true)` or `kill -9` the server.

Result: client got `close` / `readyState 3`, CPU fell to **0%**, STAT=S, one kqueue with count=0. Bun's WebSocket **parks** after a clean drop or RST.

So 49862's spin was **not** "Bun WS always busy-loops when Chrome is gone". A dead socket that actually fires `close` is fine.

### H2. `await new Promise(() => {})` is a spin loop

False. That parks. STAT would be S if that were the only thing running. 49862 was R. Something else was running JS.

### H3. Duplicate unref'd arms from a pid race (the "5 processes")

**True.** Sequence:

1. Agent session A runs `attach`. `startArmBackground` spawns child 1, `unref`s, parent exits. Child 1 is still in `connectBrowser`. Pid file is missing or stale.
2. Agent session B (or A again) runs `attach`. `isArmAlive` is false. Spawns child 2. `unref`. Repeat.
3. Each child eventually connects to the **same** browser WS, enables Network on **all** tabs, and parses the **same** event flood.
4. Last child to write the pid file wins. The others are invisible to `arm --stop` and to `isArmAlive`. They stay on PPID 1 until reboot or a manual kill.
5. Five `attach` calls across Claude/Grok/Cursor sessions = five parsers.

That matches "5 processes like that with high CPU when nothing is happening." The user was not doing five captures. Agents were.

### H4. "Idle" is not idle: background tabs keep chatting

**True, and this is the CPU while the browser is still up.**

`Network.enable` on every http(s) page **and iframe** means GitLab GraphQL, GitLab Sentry envelopes, `bat.bing.com`, `localhost:3000` HMR, muj.cez.cz analytics, CAS iframes, all of it.

`Conn.onmessage` did `JSON.parse(String(ev.data))` on **every** CDP packet, then the arm listener returned early for methods it did not record. The parse already happened. `Network.dataReceived` and `Network.webSocketFrame*` are high-rate and large. Filtering after parse does not save CPU.

The jsonl tail proved it: 84 `dataReceived` vs 14 `requestWillBeSent` in 252 events.

### H5. `appendFileSync` per event on a 635 MB file

**True as an amplifier.** Every event: open, write one line, close. 293k syscalls. As the file grew, that got worse. Not the whole story (CPU stayed high after mtime froze), but it is why a live arm pegged a core during capture.

### H6. After the port moved, orphans kept running

**True.** Brave/Chrome had been on 9222, later Chrome listened on 9223. jsonl froze at 20:20 (last Bing ping / websocket close). The process had no sockets and no close handler, so it did not exit. Combined with H3, you keep N dead-or-half-dead parsers.

Whether JS was still parsing a backlog, or Bun still had a half-open WS that did not fire `close` in that specific Chrome-restart case, we did not get a second sample of 49862 after the first. The RST repro did fire `close`. Chrome's debugger websocket on process death may differ. The health check (`GET /json/version` three failures) covers that without needing to win the Bun-vs-Chrome close argument.

---

## 5. What was *not* the leak

These were on the machine the same afternoon and look similar in Activity Monitor if you sort by CPU.

### chrome-devtools-mcp (many, ~0% CPU)

Pairs of `chrome-devtools-mcp` + `.../telemetry/watchdog/main.js --parent-pid=...`. One pair per agent session that loaded the MCP server. They were **idle**. Do not kill them thinking they are the arm. They are not `/tmp/cdp-arm-*.pid`.

### Kibana `--scan` (five bun processes, 55-99% CPU)

```
col-tools kibana logs --env wso2-prod --query 'GET /commonauth' --scan ...
col-tools kibana logs --env wso2-prod --query 'oauthErrorCode' --scan ...
```

PIDs like 10493 (69 min CPU in 86 min elapsed), 12031, 12167, 12232, 67303 (already running more than a day). These are **not** CDP arms. They are stuck Elasticsearch scans from another investigation. If the machine is still hot after arms are gone, look here.

### cmux, WindowServer, Spotify Helper (Renderer)

Also high that day. Unrelated.

---

## 6. First fix (wrong): disable auto-arm

We flipped `attachSpawnsArm()` to `false`, required `--match` or `--all-tabs`, default TTL 600s, and made `runArm` wait on websocket close / timeout / SIGTERM.

That stops the leak by not having an arm. The user then said: **let it arm**, find the leak. Auto-arm is the point of `har` attach-until-now.

Keep the death pact. Put auto-arm back. Fix uniqueness and parse volume.

---

## 7. The actual fix (current code)

Files:

- `scripts/arm.ts` (policy + `runArm`)
- `scripts/cdp.ts` (`Conn` optional `dropRaw`)
- `scripts/chrome-devtools.ts` (`startArmBackground`, CLI)
- `scripts/arm.test.ts`, `scripts/arm-cli.test.ts`
- `SKILL.md`

### 7.1 One process per port

Parent writes the **child pid immediately** after `Bun.spawn`, before the child connects.

```ts
const child = Bun.spawn(["bun", script, "arm", "--port", String(port), "--all-tabs", "--seconds", "0"], {
  stdin: "ignore", stdout: "ignore", stderr: "ignore",
});
const claimed = claimArmPort(port, child.pid);
if (!claimed.claimed) {
  child.kill();  // lost the race, do not keep a second parser
  return;
}
child.unref();
```

`claimArmPort`: if the pid file names a **live** process, refuse. If missing or dead, take over.

The child must **not** treat its own pid as a duplicate (`shouldExitAsDuplicate`). Otherwise: parent writes child.pid, child starts, `isArmAlive` is true, child exits 0 and you have no arm.

### 7.2 Drop noise before JSON.parse

`Conn` takes `dropRaw?: (raw: string) => boolean`. The arm passes `shouldDropCdpPacket`:

```ts
raw.includes('"method":"Network.dataReceived"')
|| raw.includes('"method":"Network.webSocketFrame')
```

That hits `webSocketFrameReceived`, `Sent`, `Error`. Command responses (`{"id":1,"result":...}`) are kept. `watch --channels ws` does **not** pass `dropRaw`, so frame capture still works there.

We still `Network.enable` on pages and iframes (SSO/CAS login lives in iframes). We just do not parse the high-rate packets.

### 7.3 One log fd

`openSync(jsonl, "w")` then `writeSync(fd, line)` for the life of the arm. `closeSync` in `finally`. No `appendFileSync` per event.

### 7.4 Die when CDP dies

Every 2s: `GET http://127.0.0.1:<port>/json/version` with a 1s timeout. Three consecutive failures abort the arm (`healthIsDead`). Also exit on websocket `close`/`error`, SIGTERM/SIGINT, `arm --stop`, and optional `--seconds`.

Attach-spawned arms use `--seconds 0` (until CDP drops). Explicit `arm` without `--seconds` still defaults to 600 in `resolveArmSeconds` as a forgotten-process net. Pass `--seconds 0` to wait only on CDP death.

Bare CLI `arm` still requires `--match <url>` or `--all-tabs`. Attach uses `--all-tabs`.

### 7.5 What we did **not** change

- `unref()` is still there. The arm must outlive `attach`. Uniqueness + health check is what stops orphans, not "never unref".
- Auto-arm on `attach` is **on** (`attachSpawnsArm() === true`).
- One arm **per listed endpoint**. Two browsers with CDP (broken vs working) is two arms. That is intended. The race was many arms on the **same** port.

---

## 8. How to see it on a machine

```bash
# live arms
ps -axo pid,ppid,pcpu,etime,stat,command | awk '/chrome-devtools\.ts arm/'

# pid + capture (may be leftover after death)
ls -lh /tmp/cdp-arm-*.pid /tmp/cdp-arm-*.jsonl
cat /tmp/cdp-arm-9222.pid
kill -0 $(cat /tmp/cdp-arm-9222.pid) && echo alive || echo stale

# no sockets + STAT=R + kqueue = the 49862 fingerprint
lsof -nP -p <pid>
ps -p <pid> -o pid,stat,pcpu,time,etime,command
sample <pid> 2 -file /tmp/sample-arm.txt

# who listens
lsof -nP -iTCP:9222
lsof -nP -iTCP:9223
```

Stop one port:

```bash
bun chrome-devtools.ts arm --port 9222 --stop
# or kill $(cat /tmp/cdp-arm-9222.pid)
```

Do not `pkill -f chrome-devtools.ts`. That can hit MCP, watch, and the CLI you are typing.

The jsonl is the capture. Do not `rm` it if you still want `har --from-arm`. `/tmp` clears on reboot.

---

## 9. Porting checklist

When you copy this skill to another repo:

1. Copy `scripts/arm.ts`, `scripts/cdp.ts`, `scripts/chrome-devtools.ts`, the `*.test.ts` files, and `SKILL.md`. This document is the "why".
2. Keep **claim-then-unref**, not unref-then-maybe-write-pid.
3. Keep **drop-before-parse**. Filtering in the listener is too late.
4. Keep **health probe**. Do not trust Bun `WebSocket.close` alone against Chrome's debugger socket.
5. Keep **shouldExitAsDuplicate**. Easy to regress: "pid file exists and is alive" looks like a duplicate of yourself.
6. Do not `appendFileSync` in a CDP event handler.
7. `Conn` `dropRaw` is arm-only. `watch --channels ws` must not use it.
8. Tests: `bun test scripts/` (54 passed here, 2026-08-25). The leak tests are in `arm.test.ts`: `claimArmPort`, `shouldDropCdpPacket`, `healthIsDead` / `probeCdp`, `shouldExitAsDuplicate`, `waitUntilArmDone`. CLI: `arm-cli.test.ts` (bare `arm` exits 1, no pid file).
9. `/tmp/cdp-arm-<port>.{pid,jsonl}` is the on-disk contract. `har` reads the jsonl. Changing the path is a SKILL.md + `armPaths()` change together.

### Contract the ported skill must keep

| Action | Required behavior |
|---|---|
| `attach` lists a port | At most one arm for that port. Pid claimed **before** CDP connect. |
| Second `attach` same port | Log `arm already up`, kill the extra child if spawn raced. |
| Background tabs chatting | CPU stays near idle: no parse of `dataReceived` / websocket frames. |
| Browser quits or port moves | Arm exits within ~6s (3 x 2s probes), pid file unlinked, jsonl kept. |
| `arm` with no `--match` and no `--all-tabs` | Exit 1, write nothing. |
| `arm --stop` | SIGTERM the pid in the pid file. jsonl kept. |

---

## 10. Numbers to quote

| Thing | Value |
|---|---|
| PID | 49862 |
| Command | `bun chrome-devtools.ts arm --port 9222` |
| Parent | 1 (launchd) |
| Start | 2026-08-25 15:52:35 |
| Inspect | 2026-08-25 ~20:22 |
| Live CPU | 45-87% |
| CPU time | 3m 15s / 4h 32m |
| RSS / peak | 113 MB / 211 MB |
| jsonl | 635 MB, 293,040 lines, froze 20:20 |
| Sockets at inspect | none |
| Browser then | Chrome on 9223, nothing on 9222 |
| Bun | 1.3.13 |
| WS-after-RST repro | close fires, 0% CPU |
| Test suite after fix | 54 pass, 0 fail |

---

## 11. Short version for a commit message

```
attach spawned unref'd CDP arms before the child wrote its pid, so every
later attach added another Network.enable parser. Each JSON.parsed every
dataReceived and websocket frame from every tab (GitLab, Sentry, Bing),
which looks idle and is not. Orphans survived the browser leaving 9222.

Claim the child pid immediately, drop those packets before parse, write
the jsonl through one fd, and exit after three /json/version failures.
```
