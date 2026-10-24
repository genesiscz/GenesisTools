# Auditing Swift code for cost and wrong state

Use this when you review or audit SwiftUI and AppKit code for performance and correctness, or before you call your
own change done. A code audit finds the shape; a measurement ([measuring.md](measuring.md)) decides whether the user
notices. Rules come from the skills distilled on 2026-10-24 ([sources.md](sources.md)) and from this repo's
measurements ([performance.md](performance.md), [gotchas.md](gotchas.md)).

## 0. Facts about this codebase that decide which advice applies

- State is `ObservableObject` with `@Published` (114 types, 667 properties, 0 `@Observable`, 2026-10-24). Every
  view that observes an object runs its body on ANY publish of that object, so the width of an object is the width
  of its redraws. Advice written for `@Observable` (per-property tracking) does not apply until a type moves.
- The packages build in Swift 5 language mode for macOS 14. Swift 6 and macOS 26 or 27 advice is in the later list
  of [sources.md](sources.md).
- Data comes from the `tools` CLI. Each call is a process (about 350 to 420 ms on this Mac) unless a resident hub
  server door answers it.
- `DispatchQueue.main.async` is the local pattern (225 sites); it is not a defect by itself.
- Measured facts beat skill claims: a removed `AnyView` root changed nothing here, and `TimelineView` with `Canvas` is
  an idle-CPU cost here. [sources.md](sources.md) lists the advice to reject.

A finding names how often the cost happens (per key, per publish, per snapshot, per second, once at open) and what
the user notices. A shape with no frequency is a candidate for a measurement, not a finding.

## Size the surface first: about 10,000 lines per audit

One audit pass reaches only the files it opens before its report is full, so a large area is sampled, not audited.
Measured on 2026-10-24 with the same skill and model against 36 verified defects: whole areas of 39,000 and 112,000
lines found 27 to 40%; the same code split into surfaces of 6,000 to 21,000 lines found 19 of 21, and a 13,000-line
area found 13 of 15. Count first (`cat $(fd -e swift . <folder>) | wc -l`); split anything over about 15,000 lines by
feature folder or by file group (window shell, lists, models), and audit each surface on its own, in parallel when you
can. Merge the reports and drop duplicates at the end.

## Start with the scanner

```bash
bun .claude/skills/swift/scripts/swift-scan.ts <files or folders of the area>
```

It runs the search recipes of the seven passes below in one go. Narrow checks print each line; broad checks
(task restarts, derived lists, rows that observe a model, identity, observers) print the files ranked by hit count,
so you know which files to read first. A line is a candidate, not a finding: for each one, follow the callers to
learn which thread runs it and how often. Walk every pass of the output. A file that tops several broad checks
(a big view file, a model with many `@Published` properties) is where the costly defects cluster: read it whole.

## 1. The main thread

- **Never read files, stat paths, encode JSON, run processes, decode images or query a database on the main thread**
  from a body, a click handler, a timer, a menu validator or a `@MainActor` model. Find:
  `rg -n 'String\(contentsOf|Data\(contentsOf|NSImage\(contentsOf|contentsOfDirectory|enumerator\(at|fileExists\(|attributesOfItem|Process\(\)|waitUntilExit|Thread\.sleep|JSONEncoder\(\)\.encode|CIContext\(\)|FileLock\.withLock' <files>`.
  A hit is a defect only when its function runs on the main actor on a click, a tick or a publish; read the caller.
  `validateMenuItem` runs on every menu open.
- **Apply an incoming batch with one main-actor hop and one write** to published state, never one write per item:
  build the new array locally, then assign once. Find `for … in … {` with `self.<published>.append(` or an indexed
  write inside it.
- **Set time-sensitive UI state in the synchronous action**, then start a `Task` for the long work.
- **A hang can be waiting, not computing**: a lock, synchronous I/O, an actor or a dependency cycle. Read the main
  thread's CPU time before blaming CPU.

## 2. Work that runs too often

- **Coalesce file events and task restarts, and skip the work when nobody consumes the result.** Every
  `FSEventStreamCreate`, `DirectoryWatcher(` and `.task(id:)` gets three questions: does it ignore paths nobody
  reads (build output, caches), does it debounce, and does anyone consume the result right now (a hidden window, a
  file no reader watches)? Find: `rg -n 'FSEventStreamCreate|DirectoryWatcher\(|\.task\(id:' <files>`.
- **A loop that probes or polls** (`Task.sleep(for: .seconds(` inside a `.task`) runs for every window that exists,
  also behind other windows. Probe on appear and on the action that needs it ([performance.md](performance.md),
  "Polling watchers").
- **A process per call** ([SKILL.md](../SKILL.md) table): list every `ToolsBridge` call site and its trigger. A
  prewarm that starts a process for a view the user may never open costs a process each time; a lookup per item
  where many items share one answer needs a dedupe first.
- **Build a change signature from cheap fields** (flags, counts, `isEmpty`), never from a large text.
- **Return the input unchanged when a patch or overlay is empty**, before any encode and decode round trip.

## 3. Redraws wider than the change

- **A fast-changing value lives in its own small `ObservableObject`**, read only by the view that shows it: an audio
  level, a partial transcript, a draft text, a progress value. On a shared model it redraws every pane that observes
  the model, many times a second. Find:
  `rg -n '@Published .*(level|rms|partial|micLevel|voiceText|progress|draft)' <files>`, then count the views that
  observe the owner. The fix is a small meter object that only the bars read.
- **A row gets the element it shows**, never the whole store plus an id or index it must search, and never an
  `@ObservedObject` it only calls actions on. Find: `rg -n 'first \{ \$0\.(key|id) ==|\.filter \{ \$0\.' <files>` in
  view files, and `@ObservedObject var` in row structs ([performance.md](performance.md), "Rows take values").
- **A list view observes only what it reads.** A list that observes a large model re-runs its filter, group and sort
  for every unrelated publish. Hand it the values, or split the model.
- **Own a model with `@StateObject`**; never `@ObservedObject var x = X()` with an inline initializer (it is recreated
  with the parent).
- **Keep fast-changing values and closures out of environment keys**: every reader checks the whole
  `EnvironmentValues`.

## 4. Work inside a body

- **Build formatters, regexes, decoders and parsed markdown once** (a `static let` or the model), never in a body,
  in a computed property the body reads, or in a row. Find:
  `rg -n '(DateFormatter|NumberFormatter|ISO8601DateFormatter|RelativeDateTimeFormatter|ByteCountFormatter|JSONDecoder|NSRegularExpression)\(\)|\.regularExpression|AttributedString\(markdown:' <files>`,
  then follow every computed property and function the body calls, not only `some View` helpers (a formatter in
  `private var items: [Item]` that the body reads is in the body). One create-and-format costs about 135 µs (Axiom,
  measured), so 100 rows cost about 14 ms per update.
- **Derived lists (filter, sort, group, join) are computed once per change of their inputs**, in the model. Find
  computed arrays and strings read from a body: `rg -n 'private var \w+: \[' <files>`, `.joined(separator:` and
  `localizedCaseInsensitiveContains` inside a body. A filter over a thousand items per keystroke is a hitch.
- **`View.init` and `@State` defaults copy inputs in constant time**; loads start in `.task` or in a model.
- **Each `ForEach` element makes a constant number of views**: no `if` filter or `AnyView` inside the closure; filter
  in the model. Give `ForEach` a stable id from the model: never indices, offsets, `UUID()` or `id: \.self` over
  values that change or repeat.
- **Vary a modifier's value inside one view**; an `if`/`else` on the root or a conditional-modifier helper resets
  identity and state. Change `.id` only to reset on purpose, keyed to one value; never `.id(UUID())` or `Date()`.
- **A lazy row is recycled**: keep state that must survive in the model; `onAppear` is not a one-time hook.
- **Bind through projected state or key paths**; no `Binding(get:set:)` built in the body of a repeated or hot view.
- **Read geometry once at a stable container** with `onGeometryChange`; no `GeometryReader` or geometry preference
  in each row.
- **Add `.equatable()` only where comparing the inputs costs less than the body**, and measure it.

## 5. Animation and drawing

- **Attach an animation to the smallest view that changes, always with `value:`**, and animate opacity and
  transform, not layout, blur or shadow. A `withAnimation` opens a transaction for every view that re-renders
  ([performance.md](performance.md), "A SwiftUI animation costs the whole graph it lives in").
- **No `withAnimation` around a first load or a bulk change** of a list ([gotchas.md](gotchas.md)). Where a list
  helper offers a guard (`SWR.animates(before:after:limit:)` in the hub), use it.
- **A continuous animation belongs to the render server**: a layer animation in an `NSViewRepresentable`, never a
  SwiftUI `repeatForever` in a big hosting view, and never an audio-rate SwiftUI animation (feed a layer at 15 to
  20 Hz). In a Core Animation wrapper, create layers once and start an animation only when its target changed.
- **Put a `TimelineView` in the leaf that needs the ticker**, with a schedule that matches the visible precision.
- **In a custom `Layout`, measure children once** (`makeCache`) and reuse the sizes in `placeSubviews`.

## 6. AppKit bridging and windows

- **In `updateNSView`, compare before writing** to the AppKit view (`rootView`, `stringValue`, `image`), refresh the
  coordinator's `parent`, and never set `frame` or `bounds`. Find: `rg -n 'func updateNSView\('`, then read each for
  unconditional sets. An unconditional `rootView` assignment rebuilds a nested hosting view on every update.
- **Every observer, timer, event monitor and sink a representable creates is removed** in `dismantleNSView` or the
  coordinator's `deinit`.
- **Give each `NSViewRepresentable` a sizing story** (`sizeThatFits` or `intrinsicContentSize`) that handles a nil or
  zero proposal.
- **Configure a floating panel explicitly**: non-activating style, `canBecomeKey`, `hidesOnDeactivate`, collection
  behaviour, and the level last.
- Liquid Glass: neighbouring `glassEffect` views share one `GlassEffectContainer`; glass is for chrome, applied after
  layout modifiers, never stacked with a material. SwiftUI does not hit-test glass, so a glass panel needs
  `.contentShape` ([gotchas.md](gotchas.md)).

## 7. Concurrency and state that is wrong or late

- **In a sink on a `@Published` publisher, use the emitted value** or `.receive(on: RunLoop.main)`: the publisher
  fires in `willSet`, so the property still holds the old value. Find: `rg -n '\$\w+\s*\.sink|\.sink \{'`, then check whether the closure reads the owner's property.
- **Cancellation is a normal end**: never show `CancellationError` as a failure; check `Task.isCancelled` in long
  loops. Store the running `Task` so an expensive load is single-flight, and re-check state after every `await`.
- **No unowned `Task {}` in a loop**, and no thrown error that vanishes inside `Task { try … }`.
- **State why each `Task.detached` detaches**; otherwise a plain `Task` keeps priority and cancellation.
- **Never block a cooperative thread** with a semaphore or a group wait inside async code. Resume a checked
  continuation exactly once on every path; give an `AsyncStream` an explicit buffering policy.
- **Write the invariant beside each `@unchecked Sendable`, `nonisolated(unsafe)` or `@preconcurrency`.** In closures
  SwiftUI may run off the main thread (`visualEffect`, `Shape.path`, `Layout`, `onGeometryChange`), capture copied
  values, not `self` or a model.
- Read the package's language mode and strict-concurrency level before you judge a concurrency finding.

## 8. Report

One block per finding: where (path:line), what the user notices and how often, the rule (this file's section or the
reference it points to), the code quoted, the fix in one sentence. Order by cost: stalls and hangs, idle CPU and
wrong state first; hitches in frequent actions next; rare or small costs last. End with **Coverage**: one line per
section above with the searches run, their hit counts, and the findings or "none". Put a shape whose cost depends on
numbers you do not have under **Needs a measurement**, with the instrument and the result that would confirm it.
