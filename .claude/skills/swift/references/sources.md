# Where the 2026-10-24 rules came from, what to reject, and what waits

On 2026-10-24 about 110 SwiftUI and AppKit agent skills were found (the first UX search, GitHub code search and the
skill registries) and read as data, never installed or run. Their rules were judged against this skill (105, 91 and
about 150 rules before merging), merged into 45 rules, and checked against a code audit of the app that found 36
confirmed defects ([audit.md](audit.md) holds the result). The notes, with every quote, file and line and the hit
counts in `src/macos`, are in the GenesisBrain vault under `GenesisTools/2026-10-24-SwiftPerfSkills/`
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
