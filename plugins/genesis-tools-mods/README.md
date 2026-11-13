# genesis-tools-mods

Claude Code mods for GenesisTools. A mod changes what a Claude Code session draws or does: a band above the prompt,
a sidebar, a rewrite of a tool row, a timer, a refusal of a tool call. Each mod is switched and tuned in the `mods`
section of the GenesisTools hooks file (`~/.genesis-tools/agents/hooks.json`), which the plugin reads itself, so a
change needs no reinstall. The `tools agents` CLI writes that file.

The mod API is early access in Claude Code (2.1.287 and later), so a release can change it; a mod then draws
nothing and the session works as before.

## Install and switch

```bash
# Install from this repository's marketplace (user scope by default)
tools agents hooks mods install --write

# What is installed and what each mod is set to
tools agents hooks mods status

# Turn mods on or off by name, or all of them
tools agents hooks mods enable git agentsBand --write
tools agents hooks mods disable all --write

# Change one setting, and see a setting with its named values
tools agents hooks config set mods.cacheBand.warnMinutes 15 --write
tools agents hooks config describe mods.resumeGuard.minTokens

# Load the mods from this checkout in every new session, and reload them on each save
tools agents hooks mods watch --write
```

Every mod but the full diff and the idle compaction starts off. A session that was running at the install needs
`/reload-plugins` once. A session that loads this folder through `CLAUDE_CODE_PLUGIN_DIRS` (what `mods watch`
writes) reloads the mods by itself when a file here is saved. Each mod appends what it did to
`~/.genesis-tools/agents/mods-log/<mod>.jsonl`.

The full reference of every mod is the "The Claude Code mods" section of [the agents README](../../src/agents/README.md).

## The mods

- `diff` (on): the whole diff of a Bash call whose diff-hook message was cut, under the call's row.
- `idleCompact` (on): compacts an idle session 56 minutes after its last turn, before the 1-hour prompt cache expires.
- `agentModel`: a subagent's model in front of its description on its rows.
- `agentRow`: the agents panel under the prompt names each subagent's model and effort beside its type.
- `decisions`: the Decisions sidebar (`/decisions`) with every `❓ DECISION` of the session.
- `inbox`: the Inbox sidebar (`/mod-inbox`) with what the session put in the GenesisTools inbox.
- `links`: paths, commits and repeated decisions in the main loop's reply become links as it streams.
- `git`: a band row per checkout with branch, unpushed commits, changed files and PRs with CI (`/mod-git`).
- `askRow`: `[ask]` beside a finished tool row quotes the row into the prompt.
- `spinner`: the spinner line names the running tool, its time and the working subagents.
- `cacheBand`: the prompt cache countdown of this session and of the others close to expiry.
- `tmpUsage`: what the session keeps on disk and the free disk (`/mod-tmp`).
- `agentsBand`: one band row per working subagent with model, age, idle time and tool calls (`/mod-agents`).
- `hooks` and `hooksDedupe`: a band chip that counts what the hooks hand the model (`/mod-hooks`), and a dedupe of
  repeated blocks. With `mods.hooks.metrics` each injection is also a `tools metrics` event, `agent-context /
  hook.injection`, with the dims `session`, `agent`, `agentType`, `event`, `source`, `rule`, `dropped`, `model`
  (the model of the loop it went to, null while unknown) and `delivery` (`full` for an area rule's text, `pointer`
  for an `Area rules (pointer): ...` line, null for other sources):
  `tools metrics query agent-context hook.injection --group-by source,delivery,model --agg count,sum`.
- `stall`: a band row with `continue` when a reply ends on what it was about to do and nothing can wake the session.
- `resumeGuard`: refuses once a SendMessage that would resume an agent whose prompt cache went cold while it holds a
  large context. See below.

## The resume guard (`mods.resumeGuard`)

### What it does

An agent of a session (a subagent, a teammate) writes its own prompt cache, and that cache lives 5 minutes after the
agent's last call. A SendMessage to an agent that has been idle for longer makes it write its whole context to the
cache again, at the cache-write price, and then carry that context on every later call. When the follow-up needs
little of what the agent knows, a fresh agent with a short brief is cheaper.

With the mod on, a SendMessage is refused once when all of these hold:

- the recipient is an agent of this session (by its name, its id, or a teammate's name in its team);
- the message is plain text (a shutdown or plan-approval answer and a pure `notify_when_idle` subscription pass);
- the agent is not running or pending (a running agent's cache is warm);
- it has been idle for `idleSeconds` or more;
- its context at its last call (input, cache read, cache write and output) is `minTokens` or more;
- it is no teammate, or `teammates` is on.

The model reads the refusal as the tool's error. It names the idle time and the context size, and gives two ways on:
send the same message again (it then goes through), or start a new agent and put what it needs in the brief. The
same send passes until the agent has run again; after that a cold send is refused once more. A message to another
Claude session, to `main`, or to a name no agent of the session has is never refused.

The idle time comes from the plugin's agent clock: the last model request, tool call or turn end of that agent's
loop. After a reload of the mods the clock is empty, and the idle time is the age of the agent's transcript file.
The context size comes from the usage of the agent's last model response, or from the last usage in the end of its
transcript (`<project>/<session>/subagents/agent-<id>.jsonl`, or a workflow agent's file one folder further down).
When either stays unknown, the message goes through and the mod log says why.

Every decision goes to `~/.genesis-tools/agents/mods-log/resume-guard.jsonl`: the reason, the agent, its idle
seconds, its context and where each came from. Each decision on a known size is also a `tools metrics` event,
project `agent-context`, metric `agent.resume`, value the context in tokens, with the dims `session`, `agent`,
`agentType`, `kind` (`subagent` or `teammate`), `idleSeconds` (`<5m`, `5-15m`, `15-60m`, `60m+`), `outcome`
(`refused`, `resent`, `passed-warm`, `passed-small`), `model` (the agent's model, null while unknown) and `name`
(when the agent has one). Its context holds the exact numbers: `{ idleSeconds, contextTokens, thresholds: {
idleSeconds, minTokens } }`. A refusal after a reload of the mods counts too, with the idle time and the size the
transcript gave.

```bash
tools metrics query agent-context agent.resume --group-by outcome,idleSeconds --agg count,sum
```

A message that goes through (`resent`, `passed-warm`, `passed-small`) is remembered until the agent's next model
response, and that response's usage is one `agent-context / agent.resume.result` event: value the cache-write tokens
(the context written again), dims `session`, `agent`, `agentType`, `kind`, `model` (the model that answered),
`idleSeconds`, `decision` (the outcome that let it through) and `cache`: `hit` when the cache read is 90% or more of
the context before the pause, `miss` at 10% or less, `partial` between (the rule of the session-analyzer's
`agent-resumes.ts`). Its context is `{ idleSeconds, contextBefore, input, cacheRead, cacheWrite, output }`. One
result per passed message: a later response records nothing. A compaction of the agent forgets its remembered size,
so a refusal after it never names the size from before.

```bash
tools metrics query agent-context agent.resume.result --group-by decision,cache --agg count,sum
```

### Settings

```bash
tools agents hooks mods enable resumeGuard --write
tools agents hooks config describe mods.resumeGuard.idleSeconds
tools agents hooks config set mods.resumeGuard.minTokens recommended --write
tools agents hooks config set mods.resumeGuard.teammates false --write
```

| Key | Default | Takes |
|---|---|---|
| `mods.resumeGuard.enabled` | `false` | `true` or `false` |
| `mods.resumeGuard.idleSeconds` | `295` | a whole number from 60 to 3600, or a name below |
| `mods.resumeGuard.minTokens` | `150000` | a whole number from 20000 to 2000000, or a name below |
| `mods.resumeGuard.teammates` | `true` | `true` or `false` |

A stored value of the wrong kind, or outside the range, reads as the default.

Named values of `idleSeconds`:

- `295` **recommended**: 5 s before the measured edge. Pauses of 4:45 to 5:00 hit the cache in 10 of 11 cases;
  pauses of 5:00 to 5:15 hit in 3 of 15.
- `300` **exact**: the lifetime Anthropic sells. Use it when you measure idle time from the request start.
- `330` **sure-miss**: refuses only when the miss is near certain (hit share above 5:30 is 6 of 30, above 6:00 it is
  0 of 10). Fewer wrong refusals, a few missed ones.
- `270` **early**: refuses from 4:30. Pick it only when a send usually reaches the agent many seconds late; pauses of
  4:30 to 4:45 still hit in 7 of 8 cases, so most of these refusals are wrong.

Named values of `minTokens`:

- `150000` **recommended**: from here a fresh agent is cheaper when the follow-up needs half of the old context or
  less (break-even 132k for a 66k fresh start). It covers 98% of the rewrite cost (653 of 764 cold resumes in 75 days).
- `100000` **lean-agents**: for sessions that start lean agents (about 28k); break-even there is 56k at half the
  context needed, 112k at three quarters.
- `200000` **fewer-refusals**: break-even when the follow-up needs two thirds of the context. Covers 93% of the cost
  with 15% fewer refusals.
- `300000` **only-large**: the rule in the user's own instructions ("never revive an agent idle for more than 5
  minutes that holds more than 300k"). Break-even at three quarters of the context needed. Covers 75% of the cost
  with 45% fewer refusals.

### The numbers (measured on 2026-11-11)

Source: the session-analyzer skill's `agent-resumes.ts` over every Claude Code session of 75 days on one Mac (2,727
sessions; subagent and teammate loops), at the list prices of Opus 5.5 ($5 per million tokens of 5-minute cache
write, $0.20 per million of cache read). The full measurement is the skill's `references/claude-ttl.md`.

The cache edge for subagents, in 15 s steps of the pause before the resume (hit / not hit):

| Pause | Hit | Not hit |
|---|---|---|
| 4:00 | 7 | 1 |
| 4:15 | 6 | 0 |
| 4:30 | 7 | 1 |
| 4:45 | 10 | 1 |
| 5:00 | 3 | 12 |
| 5:15 | 0 | 4 |
| 5:30 | 3 | 9 |
| 5:45 | 3 | 5 |
| 6:00 | 0 | 5 |
| 6:15 | 0 | 5 |

Resumes after 4:55 or more: 764, and 687 of them did not hit the cache. Context at the resume: p10 135k, p25 194k,
median 283k, p75 448k, p90 581k. Idle time: median 19 min, p90 100 min. The follow-up after the resume: median 13
model calls (p25 5, p75 30, p90 62).

By context band: the count, the median rewrite, the median cost of the whole follow-up, the rewrite as a share of the
follow-up, and the sum of the rewrites.

| Context | n | Rewrite | Follow-up | Share | Sum |
|---|---|---|---|---|---|
| 50k to 100k | 30 | $0.09 | $0.42 | 13% | $4 |
| 100k to 150k | 79 | $0.28 | $0.49 | 14% | $22 |
| 150k to 200k | 95 | $0.77 | $1.76 | 23% | $58 |
| 200k to 300k | 199 | $1.16 | $2.54 | 30% | $201 |
| 300k to 500k | 214 | $1.91 | $4.38 | 34% | $394 |
| above 500k | 145 | $2.91 | $6.15 | 40% | $443 |

A cold resume against a fresh agent that rebuilds what it needs. The saving of the fresh agent is
`(C - S - rho × C) × (write + read × (N - 1))`, with `C` the old context, `S` the fresh agent's start (66k measured
for general-purpose, about 28k for a lean type), `rho` the share of the old context the follow-up needs, and `N` the
follow-up calls (13). The break-even context is `C = S / (1 - rho)`: for `S` = 66k it is 66k (needs nothing), 88k (a
quarter), 132k (half), 200k (two thirds) and 264k (three quarters). A follow-up that needs all of the old context is
always cheaper as a resume (by $0.49 at `S` = 66k), whatever the size.

The saving in dollars for `S` = 66k and `N` = 13, by the share of the context the follow-up needs:

| C | 0 | 25% | 50% | 75% | 100% |
|---|---|---|---|---|---|
| 100k | 0.25 | 0.07 | -0.12 | -0.30 | -0.49 |
| 150k | 0.62 | 0.34 | 0.07 | -0.21 | -0.49 |
| 200k | 0.99 | 0.62 | 0.25 | -0.12 | -0.49 |
| 300k | 1.73 | 1.18 | 0.62 | 0.07 | -0.49 |
| 400k | 2.47 | 1.73 | 0.99 | 0.25 | -0.49 |
| 600k | 3.95 | 2.84 | 1.73 | 0.62 | -0.49 |

One refusal costs one more main-loop call: about $0.08 at a 400k main context. So the guard pays for itself when one
refusal in about eight (at 150k to 200k) leads to a fresh agent in place of a resume that needed half of the context
or less.

What each minimum would have refused in the 75 days (count, rewrite at list price):

| `minTokens` | Refused | Rewrite |
|---|---|---|
| 0 | 764 | $1,122 |
| 100k | 732 | $1,117 |
| 150k | 653 | $1,096 |
| 200k | 558 | $1,038 |
| 300k | 359 | $837 |

In the last 14 days at 150k: 143 resumes, $165.

Limits: tokens and dollars are list prices, while the accounts are subscriptions. "Needs half of the context" is a
judgment the model makes at the refusal; the guard cannot measure it. The edge is exact to about the length of one
call. The teammate data ends on 2026-09-30.

### Measure again

The session-analyzer skill (GenesisClaude) prints the same report from the sessions on this Mac:

```bash
bun scripts/agent-resumes.ts --since 75d --cold
bun scripts/agent-resumes.ts --since 75d --cold --idle-seconds 330 --fresh-start 28000
```

Run it from the skill's folder. `--idle-seconds` is the cold edge, `--fresh-start` what a fresh agent holds at its
first call, `--price-model` the model the comparison is priced for. Update the numbers above with their date when
they move.

## Tests

```bash
claude plugin test plugins/genesis-tools-mods
```

The CLI side (settings, defaults, the reader the plugin shares) is tested with
`bun scripts/test.ts src/agents/lib/hooks`.
