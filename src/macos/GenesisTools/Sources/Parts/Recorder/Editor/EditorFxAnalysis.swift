import SwiftUI

// fx B (round 4): the inspector controls of private data (Hide tab), the smooth cursor (Cursor tab) and the typing and
// waiting speed-ups (Clips tab). The lists come from the same door as the REPL and the CLI (`movie.privateData`,
// `movie.waits`, else `tools recorder private-data|waits --json`); applying sends the `hidePrivate` and
// `speedUpWaits` ops, so one undo takes each back.

/// One private hit as `tools recorder private-data --json` prints it (src/recorder/lib/fx-analysis.ts).
struct PrivateHitRow: Decodable, Equatable, Identifiable {
    struct Box: Decodable, Equatable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    let id: String
    let kind: String
    let label: String
    /// Only the first and last two characters; the window never sees the whole value.
    let masked: String
    let from: Double
    let to: Double
    let plays: Double?
    let box: Box
    let hidden: Bool
}

/// One typing or waiting stretch as `tools recorder waits --json` prints it.
struct WaitRow: Decodable, Equatable, Identifiable {
    let id: String
    let kind: String
    let from: Double
    let to: Double
    let seconds: Double
    let speed: Double
    let saves: Double
    let plays: Double?
}

extension EditorModel {
    /// The path the CLI fallback names: the edit file, as every other `tools recorder` call from the window does.
    var fxRecordingPath: String { store.url.path }

    /// Lists `T` rows from a movie method (or its CLI); `done` gets them or the failure in words.
    func fxList<T: Decodable>(_ method: String, argv: [String], done: @escaping @MainActor (Result<[T], FxListFailure>) -> Void) {
        ask(method, [:], argv: argv, timeout: 30 * 60) { result in
            switch result {
            case let .success(data):
                guard let rows = try? JSONDecoder().decode([T].self, from: data) else {
                    done(.failure(FxListFailure(reason: "The answer was not a list this window reads.")))
                    return
                }
                done(.success(rows))
            case let .failure(failure):
                done(.failure(FxListFailure(reason: failure.reason)))
            }
        }
    }

    /// Moves the playhead to a source second; a cut moment says so.
    func fxGo(toSource seconds: Double) {
        guard let out = TimelineMap.outputTime(ofSource: Int64((seconds * 1_000_000).rounded()), in: project) else {
            show("That moment was cut from the edit.", error: false)
            return
        }
        player.pause()
        seek(out)
    }
}

/// Why a list did not come, in words.
struct FxListFailure: Error {
    let reason: String
}

private func clock(_ seconds: Double) -> String {
    formatClock(Int64((seconds * 1_000_000).rounded()), tenths: false)
}

/// Hide tab: find the private data on the screen and hide the picked hits.
struct PrivateDataSection: View {
    @Bindable var model: EditorModel
    @State private var hits: [PrivateHitRow]?
    @State private var picked: Set<String> = []
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Private data", value: hits.map { Plural.count($0.count, "hit") })
            Text("Emails, tokens and keys, phone numbers, IBANs and card numbers on the screen. The text is read on this Mac with Vision; nothing leaves it.")
                .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
            WideButton(title: busy ? "Reading the Screen…" : (hits == nil ? "Find Private Data" : "Find Again"),
                       systemImage: "text.viewfinder") { find() }
                .disabled(busy)
                .instantTooltip("Reads the screen text (a movie: one frame a second, the first time can take minutes) and lists what looks private")
                .accessibilityIdentifier("recorder.hide.findPrivate")
            if let failure {
                Text(verbatim: failure).font(.system(size: 11.5)).foregroundStyle(Color(red: 1, green: 0.45, blue: 0.42))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let hits {
                if hits.isEmpty {
                    Text("No private data on the screen.").font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                }
                ForEach(hits) { hit in row(hit) }
                let open = hits.filter { picked.contains($0.id) && !$0.hidden }
                if !hits.isEmpty {
                    WideButton(title: open.isEmpty ? "All Hidden" : "Hide \(Plural.count(open.count, "Hit"))", systemImage: "eye.slash") {
                        hide(open.map(\.id))
                    }
                    .disabled(open.isEmpty || busy)
                    .instantTooltip("One blurred part per hit while it shows; ⌘Z brings them back")
                    .accessibilityIdentifier("recorder.hide.hidePrivate")
                }
            }
        }
    }

    private func row(_ hit: PrivateHitRow) -> some View {
        HStack(spacing: 8) {
            Toggle(isOn: Binding(get: { hit.hidden || picked.contains(hit.id) }, set: { on in
                if on { picked.insert(hit.id) } else { picked.remove(hit.id) }
            })) { EmptyView() }
                .toggleStyle(.checkbox)
                .disabled(hit.hidden)
                .accessibilityLabel("Hide \(hit.label) \(hit.masked)")
            Button { model.fxGo(toSource: hit.from) } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: "\(hit.label)  \(hit.masked)").font(.system(size: 12, weight: .medium)).lineLimit(1)
                    Text(verbatim: "\(clock(hit.from))–\(clock(hit.to))\(hit.hidden ? " · hidden" : "")\(hit.plays == nil ? " · cut" : "")")
                        .font(.system(size: 11).monospacedDigit()).foregroundStyle(RecorderPalette.dim)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Go to where it first shows")
        }
    }

    private func find() {
        busy = true
        failure = nil
        model.fxList("privateData", argv: ["recorder", "private-data", model.fxRecordingPath, "--json"]) { (result: Result<[PrivateHitRow], FxListFailure>) in
            busy = false
            switch result {
            case let .success(rows):
                hits = rows
                picked = Set(rows.filter { !$0.hidden }.map(\.id))
            case let .failure(problem):
                failure = "The screen text was not read: \(problem.reason)"
            }
        }
    }

    private func hide(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        busy = true
        model.applyOps(EditOp.json([.hidePrivate(EditOp.HidePrivate(ids: ids))])) { result in
            busy = false
            switch result {
            case .success:
                model.show("Hid \(Plural.count(ids.count, "private hit")) while they show. ⌘Z brings them back.", error: false)
                find()
            case let .failure(failure):
                model.show("Nothing was hidden: \(failure.reason)", error: true)
            }
        }
    }
}

/// Cursor tab: the smooth cursor's switch and its three settings.
struct SmoothCursorSection: View {
    @Bindable var model: EditorModel

    var body: some View {
        let smooth = model.project.cursorSmooth
        VStack(alignment: .leading, spacing: 10) {
            SwitchRow("Smooth cursor", isOn: Binding(get: { smooth != nil }, set: { on in
                model.setLooks { $0.cursorSmooth = on ? EditProject.CursorSmooth() : nil }
            }))
            .instantTooltip("The cursor glides along a smoothed curve, drops small trembles and fades when it rests. Clicks stay exact.")
            .accessibilityIdentifier("recorder.cursor.smooth")
            if let smooth {
                SectionLabel(text: "Strength", value: "\(Int((smooth.strength * 100).rounded()))%")
                Slider(value: Binding(get: { smooth.strength }, set: { value in
                    model.setLooks { $0.cursorSmooth?.strength = (value * 20).rounded() / 20 }
                }), in: 0...1)
                    .accessibilityLabel("Smooth cursor strength")
                SectionLabel(text: "Ignore moves under", value: String(format: "%.0f pt", smooth.jitterPx))
                Slider(value: Binding(get: { smooth.jitterPx }, set: { value in
                    model.setLooks { $0.cursorSmooth?.jitterPx = value.rounded() }
                }), in: 0...12)
                    .accessibilityLabel("Ignore cursor moves under, in points")
                SectionLabel(text: "Fade when still after", value: smooth.idleFadeSeconds == 0 ? "never" : String(format: "%.1f s", smooth.idleFadeSeconds))
                Slider(value: Binding(get: { smooth.idleFadeSeconds }, set: { value in
                    model.setLooks { $0.cursorSmooth?.idleFadeSeconds = (value * 2).rounded() / 2 }
                }), in: 0...10)
                    .accessibilityLabel("Fade the cursor when still after, in seconds")
            }
        }
    }
}

/// Clips tab: find the typing and waiting stretches, speed up the picked ones, and the speed badge.
struct WaitsSection: View {
    @Bindable var model: EditorModel
    @State private var waits: [WaitRow]?
    @State private var picked: Set<String> = []
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        let badge = model.project.autoSpeed
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Typing and waiting", value: waits.map { Plural.count($0.count, "stretch", "stretches") })
            Text("Stretches where only a small part of the picture changes (typing, a spinner, a progress bar) for 4 s or more, away from clicks and speech.")
                .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
            WideButton(title: busy ? "Comparing the Picture…" : (waits == nil ? "Find Typing and Waiting" : "Find Again"),
                       systemImage: "keyboard") { find() }
                .disabled(busy)
                .instantTooltip("Compares the picture four times a second (once per movie, then cached) and proposes 4× to 8×")
                .accessibilityIdentifier("recorder.clip.findWaits")
            if let failure {
                Text(verbatim: failure).font(.system(size: 11.5)).foregroundStyle(Color(red: 1, green: 0.45, blue: 0.42))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let waits {
                if waits.isEmpty {
                    Text("No typing or waiting stretch of 4 s or more.").font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                }
                ForEach(waits) { wait in row(wait) }
                let chosen = waits.filter { picked.contains($0.id) }
                if !waits.isEmpty {
                    WideButton(title: chosen.isEmpty ? "Pick a Stretch" : "Speed Up \(Plural.count(chosen.count, "Stretch", "Stretches"))",
                               systemImage: "forward.fill") { speedUp(chosen.map(\.id)) }
                        .disabled(chosen.isEmpty || busy)
                        .instantTooltip("Plays each at its speed with a ⏩ badge; ⌘Z puts them back")
                        .accessibilityIdentifier("recorder.clip.speedUpWaits")
                }
            }
            SwitchRow("Speed badge", isOn: Binding(get: { badge?.badge == true }, set: { on in
                model.setLooks { project in
                    var next = project.autoSpeed ?? EditProject.AutoSpeed()
                    next.badge = on
                    project.autoSpeed = next
                }
            }))
            .instantTooltip("Shows “⏩ 6x” in a corner while a part plays at 1.5× or faster")
            .accessibilityIdentifier("recorder.clip.speedBadge")
            if let badge, badge.badge {
                GenSegmentedTabs("Badge corner", items: EditProject.SpeedBadgePosition.allCases.map { .init($0, Self.cornerName($0)) },
                                 selection: Binding(get: { badge.position }, set: { position in
                                     model.setLooks { $0.autoSpeed?.position = position }
                                 }),
                                 minSegmentWidth: 44, identifier: "recorder.clip.speedBadgeCorner", fillsWidth: true)
            }
        }
    }

    private static func cornerName(_ position: EditProject.SpeedBadgePosition) -> String {
        switch position {
        case .topLeft: "↖"
        case .topRight: "↗"
        case .bottomLeft: "↙"
        case .bottomRight: "↘"
        }
    }

    private func row(_ wait: WaitRow) -> some View {
        HStack(spacing: 8) {
            Toggle(isOn: Binding(get: { picked.contains(wait.id) }, set: { on in
                if on { picked.insert(wait.id) } else { picked.remove(wait.id) }
            })) { EmptyView() }
                .toggleStyle(.checkbox)
                .accessibilityLabel("Speed up the stretch at \(clock(wait.from))")
            Button { model.fxGo(toSource: wait.from) } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: "\(wait.kind == "still" ? "Waiting" : "Typing")  \(Self.speed(wait.speed))")
                        .font(.system(size: 12, weight: .medium))
                    Text(verbatim: "\(clock(wait.from))–\(clock(wait.to)) · saves \(String(format: "%.1f", wait.saves)) s")
                        .font(.system(size: 11).monospacedDigit()).foregroundStyle(RecorderPalette.dim)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Go to the stretch")
        }
    }

    private static func speed(_ value: Double) -> String {
        value == value.rounded() ? "\(Int(value))×" : String(format: "%.1f×", value)
    }

    private func find() {
        busy = true
        failure = nil
        model.fxList("waits", argv: ["recorder", "waits", model.fxRecordingPath, "--json"]) { (result: Result<[WaitRow], FxListFailure>) in
            busy = false
            switch result {
            case let .success(rows):
                waits = rows
                picked = Set(rows.map(\.id))
            case let .failure(problem):
                failure = "The picture was not compared: \(problem.reason)"
            }
        }
    }

    private func speedUp(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        busy = true
        model.applyOps(EditOp.json([.speedUpWaits(EditOp.SpeedUpWaits(ids: ids))])) { result in
            busy = false
            switch result {
            case let .success(saved):
                model.show("Sped up \(Plural.count(ids.count, "stretch", "stretches")), saving \(formatClock(saved, tenths: true)). ⌘Z puts them back.", error: false)
                waits = nil
            case let .failure(failure):
                model.show("Nothing was sped up: \(failure.reason)", error: true)
            }
        }
    }
}
