import AppKit
import SwiftUI

/// A matching OCR line where the proxy movie shows it: fractions of the movie's picture from its top left, the same
/// space a hidden part uses (find-screen maps the frame through the proxy's letterbox).
struct ScreenBox: Decodable, Equatable {
    let text: String
    /// The line's consecutive visible run; TypeScript builds the extended hide and mark ops.
    var untilSec: Double? = nil
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

/// One moment where a text was on the screen, as `tools recorder find-screen --json` prints it
/// (src/recorder/lib/screen-search.ts `ScreenHit`).
struct ScreenHit: Decodable, Equatable, Identifiable {
    /// Seconds on the recording's clock: the proxy movie's source time.
    let sec: Double
    /// Until when that frame shows: its display's next frame.
    let untilSec: Double
    let displayId: Int?
    let file: String
    /// The frame's OCR lines that hold the text.
    let lines: [String]
    /// The movie shows this display then; a hit on another display is listed but not what plays.
    let shown: Bool
    /// The matching lines over the movie; empty when the movie does not show the frame.
    let boxes: [ScreenBox]
    /// What the hit can become, as the TypeScript side names it (src/recorder/lib/screen-ops.ts): the window sends
    /// these ops as they are and builds none itself.
    let ops: ScreenHitOps

    var id: String { file }
    var sourceUs: Int64 { Int64((sec * 1_000_000).rounded()) }
    var untilUs: Int64 { Int64((untilSec * 1_000_000).rounded()) }
}

/// The edit ops of a screen hit: `hide[i]` blurs `boxes[i]` and `mark[i]` draws a box round it while the frame shows,
/// `cut` removes the frame's time; all empty when the movie does not show the frame.
struct ScreenHitOps: Decodable, Equatable {
    let hide: [EditOp]
    let mark: [EditOp]
    let cut: [EditOp]
}

/// The Find tab: the text a frames recording or a meeting read off its screens (OCR), searched by
/// `tools recorder find-screen`, the same door as the CLI and the REPL's `findOnScreen`. A click on a moment moves the
/// playhead there.
extension EditorModel {
    /// The folder find-screen reads: the movie's own folder (a meeting's, or a library recording's).
    var recordingFolder: URL { URL(fileURLWithPath: project.source.video).deletingLastPathComponent() }

    /// The sentence for a recording that kept no screen text; the tab shows it at once, and a refused search says it too.
    nonisolated static let noScreenText = "This movie has no screen text. Only a frames recording or a meeting keeps the text it read off its screens."

    /// Whether the recording kept text off its screens: a frames recording or a meeting lists its frames in
    /// recording.json; a movie recording lists none, and a movie with no recording.json has none either (find-screen
    /// refuses both). Nil when recording.json cannot be read as JSON, so the search box stays and the door answers.
    nonisolated static func hasScreenText(recordingFolder: URL) -> Bool? {
        guard let data = try? Data(contentsOf: recordingFolder.appendingPathComponent("recording.json")) else { return false }
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return (root["frames"] as? [Any]).map { !$0.isEmpty } ?? false
    }

    /// Reads `hasScreenText` once, off the main thread (a meeting's recording.json lists every frame).
    func learnScreenText() async {
        guard screenTextKnown == nil else { return }
        let folder = recordingFolder
        let known = await Task.detached(priority: .userInitiated) { Self.hasScreenText(recordingFolder: folder) }.value
        screenTextKnown = known ?? true
    }

    /// Searches the screen text; an older answer that arrives after a newer search is dropped.
    func findOnScreen(_ query: String) {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        screenSearchRevision += 1
        let revision = screenSearchRevision
        guard !text.isEmpty else {
            screenHits = nil
            screenSearchFailure = nil
            isSearchingScreen = false
            selectedScreenHit = nil
            return
        }
        isSearchingScreen = true
        ask("findOnScreen", ["text": text], recording: recordingFolder.path,
            argv: ["recorder", "find-screen", recordingFolder.path, text, "--json"]) { [weak self] result in
            guard let self, revision == self.screenSearchRevision else { return }
            self.isSearchingScreen = false
            self.selectedScreenHit = nil
            switch result {
            case let .success(data):
                guard let hits = try? JSONDecoder().decode([ScreenHit].self, from: data) else {
                    self.screenHits = nil
                    self.screenSearchFailure = "The search answered something this window does not read."
                    return
                }
                self.screenSearchFailure = nil
                self.screenHits = hits
            case let .failure(failure):
                self.screenHits = nil
                self.screenSearchFailure = Self.screenSearchProblem(stderr: failure.reason, status: 1)
            }
        }
    }

    /// The failure in words: a movie without a recording has no screen text, anything else is the door's own line.
    nonisolated static func screenSearchProblem(stderr: String, status: Int32) -> String {
        // A movie without recording.json, and a movie recording, which keeps no frames: neither has text to search.
        if stderr.contains("has no recording.json") || stderr.contains("has no screen text") {
            return noScreenText
        }
        return "The search did not run: \(stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)")"
    }

    /// Hides the text of a hit (all its boxes, or the one at `box`) as hidden parts over that frame's time.
    func hideScreenText(_ hit: ScreenHit, box: Int? = nil) {
        applyScreenOps(hit, ops: picked(hit.ops.hide, box), box: box, done: "Hid", undo: "brings it back", failed: "was not hidden")
    }

    /// Draws a box round the text of a hit (all its boxes, or the one at `box`) over that frame's time.
    func markScreenText(_ hit: ScreenHit, box: Int? = nil) {
        applyScreenOps(hit, ops: picked(hit.ops.mark, box), box: box, done: "Marked", undo: "takes it away", failed: "was not marked")
    }

    /// Cuts the time the hit's frame shows.
    func cutScreenMoment(_ hit: ScreenHit) {
        guard !hit.ops.cut.isEmpty else { return }
        let from = TimelineMap.outputTime(ofSource: hit.sourceUs, in: project).map { formatClock($0, tenths: true) } ?? "a cut part"
        let span = String(format: "%.1f s", hit.untilSec - hit.sec)
        applyOps(Self.json(hit.ops.cut)) { [weak self] result in
            switch result {
            case .success: self?.show("Cut the \(span) from \(from) that showed the text. ⌘Z brings it back.", error: false)
            case let .failure(failure): self?.show("The moment was not cut: \(failure.reason)", error: true)
            }
        }
    }

    /// `ops` (one per box), or only box `box`'s.
    private func picked(_ ops: [EditOp], _ box: Int?) -> [EditOp] {
        guard let box else { return ops }
        return ops.indices.contains(box) ? [ops[box]] : []
    }

    /// Sends the ops of a hit's boxes in one `apply`, so one undo step, and says what it did to which lines.
    private func applyScreenOps(_ hit: ScreenHit, ops: [EditOp], box: Int?, done: String, undo: String, failed: String) {
        guard !ops.isEmpty else { return }
        let lines = box.map { hit.boxes.indices.contains($0) ? [hit.boxes[$0]] : [] } ?? hit.boxes
        let name = lines.count == 1 ? "“\(lines[0].text)”" : Plural.count(lines.count, "line")
        applyOps(Self.json(ops)) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                let from = TimelineMap.outputTime(ofSource: hit.sourceUs, in: self.project).map { formatClock($0, tenths: true) } ?? "a cut part"
                self.show("\(done) \(name) from \(from) while that frame shows. ⌘Z \(undo).", error: false)
            case let .failure(failure):
                self.show("\(name) \(failed): \(failure.reason)", error: true)
            }
        }
    }

    private nonisolated static func json(_ ops: [EditOp]) -> String {
        (try? JSONSerialization.data(withJSONObject: EditOp.objects(ops), options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? "[]"
    }

    /// Moves the playhead to a moment; a moment that was cut says so.
    func goToScreenHit(_ index: Int) {
        guard let hits = screenHits, hits.indices.contains(index) else { return }
        selectedScreenHit = index
        guard let out = TimelineMap.outputTime(ofSource: hits[index].sourceUs, in: project) else {
            show("That moment was cut from the edit.", error: false)
            return
        }
        player.pause()
        seek(out)
    }
}

/// The Find tab's content.
struct ScreenFindInspector: View {
    @Bindable var model: EditorModel
    @State private var pending: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Find on Screen").font(.system(size: 15, weight: .semibold))
                Text("Text that was on the screen while it recorded. A click on a moment goes there.")
                    .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if model.screenTextKnown == false {
                // A movie recording kept no screen text: no search box that can only ever answer "nothing".
                Label {
                    Text(verbatim: EditorModel.noScreenText).fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "text.viewfinder").foregroundStyle(RecorderPalette.dim)
                }
                .font(.system(size: 12.5)).foregroundStyle(RecorderPalette.dim)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("recorder.find.noText")
            } else {
                searchBox
                results
            }
        }
        .task { await model.learnScreenText() }
        // Searches as you type, once the typing rests: each search is one tools process. Opening the tab again keeps
        // the last answer instead of searching again.
        .onChange(of: model.screenQuery) { _, query in
            pending?.cancel()
            pending = Task {
                try? await Task.sleep(for: .milliseconds(350))
                guard !Task.isCancelled else { return }
                model.findOnScreen(query)
            }
        }
        .onDisappear { pending?.cancel() }
    }

    private var searchBox: some View {
            HStack(spacing: 6) {
                // An AppKit field: an agent's accessibility write reaches the query and searches, as typing does.
                AgentTextField("A name, an error, a link…", text: $model.screenQuery, identifier: "recorder.find.query",
                               focusOnAppear: true, onCancel: { model.screenQuery = "" }) {
                    model.goToScreenHit(0)
                }
                .frame(height: 22)
                if !model.screenQuery.isEmpty {
                    IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the search (Esc)", size: 11) { model.screenQuery = "" }
                }
            }
    }

    @ViewBuilder private var results: some View {
        if model.isSearchingScreen {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Searching the screen text…").font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
            }
        } else if let failure = model.screenSearchFailure {
            Text(failure).font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
        } else if let hits = model.screenHits {
            if hits.isEmpty {
                Text(verbatim: "No frame shows “\(model.screenQuery.trimmingCharacters(in: .whitespaces))”.")
                    .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
            } else {
                Text(verbatim: Plural.count(hits.count, "moment")).font(.system(size: 12.5, weight: .medium))
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(hits.enumerated()), id: \.element.id) { index, hit in
                        ScreenHitRow(model: model, hit: hit, selected: model.selectedScreenHit == index)
                            .rowButton(cornerRadius: 5) { model.goToScreenHit(index) }
                            .accessibilityAction(named: "Hide the Text") { model.hideScreenText(hit) }
                            .accessibilityAction(named: "Mark the Text") { model.markScreenText(hit) }
                            .accessibilityAction(named: "Cut This Moment") { model.cutScreenMoment(hit) }
                            .accessibilityAddTraits(model.selectedScreenHit == index ? .isSelected : [])
                            .accessibilityIdentifier("recorder.find.hit.\(index)")
                            .liveRow(selected: model.selectedScreenHit == index)
                    }
                }
                if let index = model.selectedScreenHit, let hit = hits.indices.contains(index) ? hits[index] : nil {
                    if hit.boxes.isEmpty {
                        Text(hit.shown ? "This frame has no line boxes to hide." : "The movie shows another display then, so there is nothing to hide.")
                            .font(.system(size: 11)).foregroundStyle(RecorderPalette.dim)
                    } else {
                        let lines = hit.boxes.count == 1 ? "this line" : "these \(hit.boxes.count) lines"
                        GhostButton("Hide This Text", symbol: "eye.slash",
                                    tooltip: "Blur \(lines) while the frame shows; the preview outlines them",
                                    fullWidth: true, identifier: "recorder.find.hide") { model.hideScreenText(hit) }
                        GhostButton("Mark It", symbol: "square.dashed",
                                    tooltip: "Draw a box round \(lines) while the frame shows",
                                    fullWidth: true, identifier: "recorder.find.mark") { model.markScreenText(hit) }
                    }
                    if !hit.ops.cut.isEmpty {
                        GhostButton("Cut This Moment", symbol: "scissors",
                                    tooltip: "Cut the \(String(format: "%.1f s", hit.untilSec - hit.sec)) this frame shows from the movie",
                                    fullWidth: true, identifier: "recorder.find.cut") { model.cutScreenMoment(hit) }
                    }
                }
            }
        } else {
            Text("Type a word you saw on the screen. Accents and case do not matter.")
                .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// One moment: where it plays (or that it was cut), its display, and the lines that hold the text.
private struct ScreenHitRow: View {
    let model: EditorModel
    let hit: ScreenHit
    let selected: Bool

    var body: some View {
        let out = TimelineMap.outputTime(ofSource: hit.sourceUs, in: model.project)
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(verbatim: out.map { formatClock($0, tenths: true) } ?? "cut")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(out == nil ? RecorderPalette.dim : RecorderPalette.text)
                if let id = hit.displayId, let plan = model.displayPlan, plan.displays.count > 1 {
                    Text(verbatim: hit.shown ? plan.name(of: id) : "\(plan.name(of: id)), not shown then")
                        .font(.system(size: 10.5)).foregroundStyle(RecorderPalette.dim)
                        .lineLimit(1)
                }
            }
            Text(verbatim: hit.lines.joined(separator: "\n"))
                .font(.system(size: 12))
                .foregroundStyle(hit.shown ? RecorderPalette.text : RecorderPalette.dim)
                .lineLimit(2)
                .truncationMode(.tail)
        }
        .padding(.horizontal, 6).padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 5).fill(selected ? RecorderPalette.zoom.opacity(0.25) : Color.clear))
        .accessibilityElement(children: .combine)
    }
}

/// The Find tab on the preview: the selected moment's matching lines, outlined where the movie shows them (through the
/// zoom and the frame) while the playhead is on that frame, each with a Hide and a Mark button.
struct ScreenBoxOverlay: View {
    let model: EditorModel
    let clock: PlayheadClock

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let sourceUs = TimelineMap.sourceTime(atOutput: clock.outUs, in: model.project)
            if let index = model.selectedScreenHit, let hits = model.screenHits, hits.indices.contains(index),
               sourceUs >= hits[index].sourceUs, sourceUs < hits[index].untilUs {
                let hit = hits[index]
                let map = model.sourceToCanvas(atOutput: clock.outUs)
                ZStack(alignment: .topLeading) {
                    ForEach(Array(hit.boxes.enumerated()), id: \.offset) { index, box in
                        let mapped = map.rect(CGRect(x: box.x, y: box.y, width: box.width, height: box.height)).intersection(map.shown)
                        if !mapped.isNull {
                            let rect = CGRect(x: mapped.minX * size.width, y: mapped.minY * size.height,
                                              width: mapped.width * size.width, height: mapped.height * size.height)
                            RoundedRectangle(cornerRadius: 3)
                                .strokeBorder(Color.yellow, lineWidth: 1.5)
                                .background(RoundedRectangle(cornerRadius: 3).fill(Color.yellow.opacity(0.14)))
                                .frame(width: rect.width, height: rect.height)
                                .allowsHitTesting(false)
                                .offset(x: rect.minX, y: rect.minY)
                            HStack(spacing: 4) {
                                IconButton(systemName: "eye.slash", tooltip: "Hide “\(box.text)” while this frame shows", size: 11) {
                                    model.hideScreenText(hit, box: index)
                                }
                                .background(Circle().fill(Color.black.opacity(0.7)))
                                IconButton(systemName: "square.dashed", tooltip: "Draw a box round “\(box.text)” while this frame shows", size: 11) {
                                    model.markScreenText(hit, box: index)
                                }
                                .background(Circle().fill(Color.black.opacity(0.7)))
                            }
                            .offset(x: min(size.width - 48, rect.maxX + 4), y: max(0, rect.midY - 11))
                        }
                    }
                }
                .frame(width: size.width, height: size.height, alignment: .topLeading)
            }
        }
    }
}
