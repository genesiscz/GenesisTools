# agent-harness

An async-first agent loop: the model issues tool calls, every call starts at once in the
background, the model gets a "still running" placeholder, and each finished result wakes a
new model turn. Results that land together arrive in the same turn, so the model spends
no turns on polling or waiting.

This is a TypeScript port of the `contextbuilder` and `coordinator` packages of
[Unreal Agent](https://github.com/unreallabsai/unreal-agent) by
[Unreal Labs](https://unreallabs.ai/blog/unreal-agent/). Their harness design, their tests
and their write-up made this port possible, and every behaviour here follows their Go code
at the commit pinned in [UPSTREAM.md](./UPSTREAM.md). Thank you, Unreal Labs.

## What it does

- **`contextbuilder.ts`** builds the model request from an append-only history. The part a
  request already carried never changes, so the provider's prompt cache keeps hitting. A
  running tool call shows `TOOL_CALL_RUNNING_PAYLOAD` until its result lands; a result that
  arrives before the next turn replaces the placeholder in place, so the model never sees it.
- **`coordinator.ts`** owns one session's decision loop: it persists every input, model
  response and tool-call status to the session store, translates tool calls into durable
  operations, dispatches them to an operation manager, and decides when to call the model
  again. Three timers shape that: a 1 ms slurp window that batches events which arrive
  together, a 1 s grace period after a batch of tool calls so fast tools finish before the
  next turn, and an optional heartbeat that wakes the model after a long silence.
- **`inbox.ts`** deduplicates inputs by id, including ids restored from history, so a
  redelivered input is not processed twice.
- **`sessionstore.ts`** is the append-only history contract plus an in-memory store.
- **`tool.ts`** and **`operation.ts`** are the contracts a host implements: a translator
  turns a model tool call into operations without I/O; a manager runs operations and reports
  their state.
- **`llm.ts`** is the model contract: one `Adapter.respond(request, options, signal)`.
- **`clock.ts`** makes time injectable. `VirtualClock` stands in for Go's `testing/synctest`.

## How the loop maps from Go

Go selects over channels in one goroutine. Here the loop races promises: an "item is
available" notification per queue, the timers, the in-flight model call and the abort
signal. Two rules keep it faithful, and both were caught by the ported Go tests:

- The race waits on "something is queued" and takes the item afterwards. Racing a consuming
  `take()` swallowed items from the losing queue and broke the batching.
- The queues are read once before the loop, like `inboxOutput := Inbox.Output()`. A
  dependency swapped mid-run must not change what the select waits on.

JSON field names keep the Go spelling (`CallID`, `WaitingFor`, ...), so session items and
fixtures are shared byte for byte with the Go runner.

## Tests

Every Go test in `harness/coordinator/*_test.go` and `harness/contextbuilder/*_test.go` has
a twin of the same name in `coordinator.<file>.test.ts` and `contextbuilder.test.ts`.
`testing/driver.ts` mirrors the Go fakes and the `stopTestRun` driver; the `testing/notes-*.md`
files record every mapping that is not one-to-one and the few subtests that cannot be
ported (Go type assertions, the unported local operation manager).

```bash
bun run test src/utils/agent-harness
```

## What is not ported

The operation runtime (`primitives`, the local operation manager), the Responses API client
and the file session store. A host supplies those: Pi's tool runner and model streaming in
GenesisPi, or an adapter over GenesisTools' AI accounts.
