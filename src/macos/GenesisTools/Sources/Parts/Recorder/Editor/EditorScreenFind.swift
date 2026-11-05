import AppKit
import SwiftUI

/// One moment where a text was on the screen, as `tools recorder find-screen --json` prints it
/// (src/recorder/lib/screen-search.ts `ScreenHit`).
struct ScreenHit: Decodable, Equatable, Identifiable {
    /// Seconds on the recording's clock: the proxy movie's source time.
    let sec: Double
    let displayId: Int?
    let file: String
    /// The frame's OCR lines that hold the text.
    let lines: [String]
    /// The movie shows this display then; a hit on another display is listed but not what plays.
    let shown: Bool

    var id: String { file }
    var sourceUs: Int64 { Int64((sec * 1_000_000).rounded()) }
}

/// The Find tab: the text a frames recording or a meeting read off its screens (OCR), searched by
/// `tools recorder find-screen`, the same door as the CLI and the REPL's `findOnScreen`. A click on a moment moves the
/// playhead there.
extension EditorModel {
    /// The folder find-screen reads: the movie's own folder (a meeting's, or a library recording's).
    var recordingFolder: URL { URL(fileURLWithPath: project.source.video).deletingLastPathComponent() }

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
        ToolsRunner.run(["recorder", "find-screen", recordingFolder.path, text, "--json"]) { [weak self] status, stdout, stderr in
            guard let self, revision == self.screenSearchRevision else { return }
            self.isSearchingScreen = false
            self.selectedScreenHit = nil
            guard status == 0, let hits = try? JSONDecoder().decode([ScreenHit].self, from: Data(stdout.utf8)) else {
                self.screenHits = nil
                self.screenSearchFailure = Self.screenSearchProblem(stderr: stderr, status: status)
                return
            }
            self.screenSearchFailure = nil
            self.screenHits = hits
        }
    }

    /// The failure in words: a movie without a recording has no screen text, anything else is the door's own line.
    nonisolated static func screenSearchProblem(stderr: String, status: Int32) -> String {
        if stderr.contains("has no recording.json") {
            return "This movie has no screen text. Only a frames recording or a meeting keeps the text it read off its screens."
        }
        return "The search did not run: \(stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)")"
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
    @FocusState private var focused: Bool
    @State private var pending: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Find on Screen").font(.system(size: 15, weight: .semibold))
                Text("Text that was on the screen while it recorded. A click on a moment goes there.")
                    .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                TextField("A name, an error, a link…", text: $model.screenQuery)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .onSubmit { model.goToScreenHit(0) }
                    .onExitCommand { model.screenQuery = "" }
                    .accessibilityIdentifier("recorder.find.query")
                if !model.screenQuery.isEmpty {
                    IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the search (Esc)", size: 11) { model.screenQuery = "" }
                }
            }
            results
        }
        .onAppear { focused = true }
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
                            .accessibilityAddTraits(model.selectedScreenHit == index ? .isSelected : [])
                            .accessibilityIdentifier("recorder.find.hit.\(index)")
                            .liveRow(selected: model.selectedScreenHit == index)
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
