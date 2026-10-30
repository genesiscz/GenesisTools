# Where the 2026-10-24 rules came from, what to reject, and what waits

On 2026-10-24 about 110 SwiftUI and AppKit agent skills were found (the first UX search, GitHub code search and the
skill registries) and read as data, never installed or run. Their rules were judged against this skill (105, 91 and
about 150 rules before merging), merged into 45 rules, and checked against a code audit of the app that found 36
confirmed defects ([audit.md](audit.md) holds the result). The notes, with every quote, file and line and the hit
counts in `src/macos`, are in the notes vault under `GenesisTools/2026-10-24-SwiftPerfSkills/`
(`Research-SwiftRulesMerged` is the merged list; `SwiftChanges` is the list of defects).

## The skills worth citing

- **avdlee/swiftui-agent-skill@swiftui-expert-skill**: state management, rows that take values, scoped animation,
  `updateNSView` rules.
- **twostraws/swiftui-pro**: rows get the element, `.task` over `onAppear`, always an animation value.
- **dpearson2699/swift-ios-skills** (swiftui-performance, swiftui-animation): no blocking I/O on the main actor,
  transaction ownership.
- **livsy90/iOS-Performance-Agent-Skills** (swiftui-performance, swift-concurrency-performance): layout against
  transform animation cost, batching, cooperative threads.
- **charleswiltgen/Axiom** (axiom-macos, axiom-analyze-swiftui-performance): measured formatter cost, AppKit
  interop, key view loop.
- **yigitkonur/plugin-swiftui** (audit skills; few stars, so only rules a second source or the audit confirmed):
  representable lifecycle, main-actor hops, cancellation.
- **Dimillian/skills** (swiftui-performance-audit, swiftui-ui-patterns, swiftui-view-refactor): cached formatters,
  coalesced async work.
- **emilkowalski/skills@write-swift**, **daneden/agent-skills@swiftui-gotchas**, **openai/plugins** (AppKit interop),
  **AutisticAF/claude-code-apple-dev-plugin**, **jamesrochabrun/skills@swift-concurrency**,
  **rshankras/claude-code-apple-skills**, **ilianovi3/swift-skills@optimize-swift** (Layout cache; one source, kept
  because the audit confirmed it).
- Thin or wrong: the four LaughingJackalope/macos-skills (claims that contradict Apple's docs and the AppKit headers),
  pproenca (unmeasured `drawingGroup` gains, `TimelineView` plus `Canvas` as fast). One registry skill claimed to be
  written by Apple and to supersede model training; it was skipped.

## Advice to reject here

Each of these contradicts a measurement in this skill or a fact of this codebase.

- "`AnyView` defeats diffing, always remove it": removing an `AnyView` root changed nothing measurable here
  ([performance.md](performance.md)).
- "`TimelineView(.animation)` with `Canvas` is the fast path": it was an idle-CPU cost here; a layer animation is.
- "SwiftUI transforms are GPU-accelerated, so animate freely": a SwiftUI animation lays out the whole graph it lives
  in ([performance.md](performance.md), measured).
- "Use `PhaseAnimator` or `KeyframeAnimator` for a looping pulse": still a SwiftUI animation per frame.
- "Never use GCD" / "migrate to Swift concurrency first": the app builds in Swift 5 mode with 225
  `DispatchQueue.main.async` sites; migrate per measured need, not as a sweep.
- "Prefer SwiftUI over AppKit bridging": the measured fixes here are AppKit (layer animations, `NSPanel`).
- "A per-row `@Observable` model for list rows": not applicable to `ObservableObject`; rows take values.
- "`ImageRenderer` for view images": see the snapshot rules in `.claude/rules/macos-app.md`.
- A flat "use a lazy stack from 50 items": measure; the `LazyVStack` cost per scroll event is in
  [performance.md](performance.md).
- `drawingGroup` as a general fix: the skills disagree and nobody measured it here.

## Later (needs `@Observable`, Swift 6, or macOS 15, 26 or 27)

- Move hot `ObservableObject` types to `@Observable`: a view then updates only for the properties its body reads.
  It needs a replacement for `RenderProbe.watch`, which counts `objectWillChange`. It would fix
  whole-window redraws from one shared model at the root.
- After that: `@ObservationIgnored` caches, Equatable stored types, flattened dependencies, AppKit observation
  tracking in `layout()` and `draw(_:)` (macOS 26), `Observations { }` (macOS 26).
- Swift 6 mode: `@concurrent`, isolated conformances, static isolation over `MainActor.run`, per-target migration.
- macOS 15 and 26 window APIs: `WindowDragGesture` (replaces `isMovableByWindowBackground`, a trap in
  [gotchas.md](gotchas.md)), `windowResizeAnchor`, `@Animatable`, `NSGestureRecognizerRepresentable`,
  `NSGlassEffectView`, `scrollEdgeEffectStyle`.
- SwiftUI `WebView` and `WebPage` (macOS 26): bench against the `WKWebView` spare first.
- macOS and Xcode 27: `ToolbarOverflowMenu`, `reorderable`, Instruments 27.

## How SwiftUI decides to re-run a body (2026-10-30 20:30)

Distilled from the research note `Dev/Swift/2026-10-30-Research-SwiftUIRerender.opus.md` in the notes vault (quotes, the
test scripts with their output, and the claims ledger). Each line names its evidence: Apple documentation, a WWDC
session, the Swift source, or a local test (Swift 6.3.3, macOS 26.3.1, tests T1 to T6 of the note). A line marked
"observation" rests on our own samples only; nothing here turns a hub measurement into documentation.

- A `@Published` set publishes in `willSet`, before the value is stored, so a sink that reads the property sees the
  old value ([Published](https://developer.apple.com/documentation/combine/published)).
- The publish is synchronous on the setting thread, and an equal value publishes too; Apple documents no equality
  check (test T1).
- `@ObservedObject` invalidates the view on every publish of the object, whatever its body reads
  ([ObservedObject](https://developer.apple.com/documentation/swiftui/observedobject),
  [Migrating to the Observable macro](https://developer.apple.com/documentation/swiftui/migrating-from-the-observable-object-protocol-to-the-observable-macro)).
- A change does not run a body at once: it marks the dependent views outdated and each runs once at the next update,
  so body runs follow the number of updates that carried a change, not the number of sets
  ([WWDC20 10040](https://developer.apple.com/videos/play/wwdc2020/10040/) "coalesce every change into a single update",
  [WWDC25 306](https://developer.apple.com/videos/play/wwdc2025/306/); test T3).
- `@Observable`: a view depends only on the properties its `body` reads, through computed properties too
  ([WWDC23 10149](https://developer.apple.com/videos/play/wwdc2023/10149/),
  [Managing model data](https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app)).
- A read inside a closure that runs later (a `List` row builder, an action, a task) belongs to whoever runs the closure,
  not to the view that built it ([Managing model data](https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app); test T2).
- Observation is per property and per instance: an array property notifies on its own mutation, not on changes inside
  its elements ([SE-0395](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0395-observability.md)).
- Observation notifies in `willSet`, synchronously on the mutating thread
  ([ObservationRegistrar.swift](https://github.com/swiftlang/swift/blob/main/stdlib/public/Observation/Sources/Observation/ObservationRegistrar.swift); test T2).
- Swift 6.2 and later: an `@Observable` whole-value set of an equal `Equatable` value, or of the same object, does not
  notify; an in-place mutation (`x += 0`, `append`, `row.title = …`) always does. Guard in-place writes with an `if`;
  a plain set needs no guard ([ObservableMacro.swift at swift-6.2-RELEASE](https://github.com/swiftlang/swift/blob/swift-6.2-RELEASE/lib/Macros/Sources/ObservationMacros/ObservableMacro.swift); tests T2, T3).
- `withObservationTracking` fires once, on the first change, and then cancels itself; every observer re-arms
  ([SE-0395](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0395-observability.md),
  [ObservationTracking.swift](https://github.com/swiftlang/swift/blob/main/stdlib/public/Observation/Sources/Observation/ObservationTracking.swift)).
- A re-arm inside `onChange` reads the OLD values and misses the last change of a burst; re-arm on the next main-actor
  turn to read the landed values, or use `Observations` on macOS 26
  ([SE-0475](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0475-observed.md); test T2). The next-turn
  re-arm is what real code does (pointfreeco/swift-navigation `Observe.swift`, palmier-pro, agterm, Maccy, openclaw);
  a caller that checks the effect in the same turn sees it one turn late, so such a test waits for the landed value.
- A plain `var` of an `@Observable` class is enough for updates, `@Bindable` only adds `$` bindings, and
  `@ObservedObject` and `@StateObject` still require `ObservableObject` on the macOS 26 SDK (the migration article
  says otherwise for `StateObject`) ([Bindable](https://developer.apple.com/documentation/swiftui/bindable); test T6).
- `EquatableView` and `.equatable()` let the view's `==` decide whether its children update; leave closures out of
  `==` ([EquatableView](https://developer.apple.com/documentation/swiftui/equatableview)). Without the modifier,
  SwiftUI uses `==` only for a non-POD view (one with a `String`, a closure or a class reference) and compares a
  plain-data view field by field, ignoring its `==` (a SwiftUI team engineer as quoted in
  [SwiftUI view equality](https://chris.eidhof.nl/note/swiftui-view-equality); tests T4, T7 and angle B's ui5). Always
  apply `.equatable()`: it is the documented form and the only one that covers both.
- Without `Equatable`, SwiftUI compares the previous view value with the new one
  ([WWDC21 10022](https://developer.apple.com/videos/play/wwdc2021/10022/)): equal values, the same object and a
  non-capturing function compared equal, a capturing closure never did (test T4).
- Do not store capturing closures in views; call a view-building closure in `init` and store its result
  ([Understanding and improving SwiftUI performance](https://developer.apple.com/documentation/xcode/understanding-and-improving-swiftui-performance)).
- Lazy stacks create rows only when shown, inside `Section` too; `List` gathers every id eagerly and builds rows on
  demand, so each `ForEach` element must resolve to a constant number of rows
  ([LazyVStack](https://developer.apple.com/documentation/swiftui/lazyvstack),
  [WWDC23 10160](https://developer.apple.com/videos/play/wwdc2023/10160/); test T5).
- Lazy containers keep extra rows realised "for prefetching or accessibility"
  ([WWDC23 10160](https://developer.apple.com/videos/play/wwdc2023/10160/)).
- For repeated rows, fewer accessibility elements is the documented shape: `.accessibilityElement(children: .combine)`
  (one element), `.ignore`, `accessibilityHidden(true)` ([WWDC21 10119](https://developer.apple.com/videos/play/wwdc2021/10119/),
  [AccessibilityChildBehavior.combine](https://developer.apple.com/documentation/swiftui/accessibilitychildbehavior/combine)).
- Observation, not documentation: with an accessibility client attached, the private
  `AccessibilityNode.updateFocusResponder` and `MultiViewResponder.visit` walked every responder of the window per
  changed node ([performance.md](performance.md) "Accessibility walks during a drag of a dense list"). Apple does not
  document that walk or its cost; third-party reports show the same frames (moona3k/macparakeet#1133, an lldb count in
  dzearing/photonz) and read it the same way.
- `_printChanges()` is a debug-only, best-effort explanation of why a body ran; never ship it
  ([WWDC23 10160](https://developer.apple.com/videos/play/wwdc2023/10160/)).
- Tension with "Advice to reject" above: Apple's fix in WWDC25 306 for rows that depend on a whole array is a
  per-item `@Observable` model. Value rows that are `Equatable` remove the same dependency and also let a resting row
  drop its responders, so they stay the rule for dense rows.
