import AppKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Transcript

/// The corrected transcript (renames, confirmed items, dictionary), one line per row; the time plays the audio from
/// there. The filter field narrows the lines (⌘F puts the keyboard in it, Esc clears it).
struct TranscriptTab: View {
    @Bindable var detail: MeetingDetailModel
    @State private var filter = ""
    @FocusState private var filterFocused: Bool

    var body: some View {
        LoadablePane(state: detail.transcript, reading: "Reading the transcript…", retry: detail.loadTranscript,
                     noSource: detail.noTranscriptSource("transcript")) { transcript in
            VStack(spacing: 0) {
                FilterField(text: $filter, prompt: "Filter the transcript", focused: $filterFocused)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                Divider()
                let lines = visible(transcript.entries)
                if transcript.entries.isEmpty {
                    EmptyState(symbol: "text.alignleft", text: "This meeting has no transcript",
                               detail: "A transcript comes from its source (Wispr Flow) once the meeting is linked.")
                } else if lines.isEmpty {
                    EmptyState(symbol: "magnifyingglass", text: "No line holds “\(filter)”", actionTitle: "Clear the filter") { filter = "" }
                } else {
                    // A lazy stack, not a List: an accessibility client asked a List for every row, and AppKit then
                    // built and hosted each of the 274 rows (10 to 13 s of CPU per walk, 2026-11-06). The stack
                    // realizes only the rows near the viewport, as the Screen tab's does (0.8 s for 258 frames).
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(lines, id: \.rowID) { line in
                                TranscriptRow(line: line, play: { detail.play(at: $0) }).equatable()
                                    .padding(.horizontal, 14)
                            }
                        }
                        .padding(.vertical, 6)
                    }
                }
            }
        }
    }

    private func visible(_ lines: [TranscriptLine]) -> [TranscriptLine] {
        let query = filter.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return lines }
        return lines.filter { $0.text.localizedStandardContains(query) || $0.speaker.localizedStandardContains(query) }
    }
}

private struct TranscriptRow: View, Equatable {
    let line: TranscriptLine
    let play: (Double) -> Void

    nonisolated static func == (a: TranscriptRow, b: TranscriptRow) -> Bool { a.line == b.line }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            if let start = line.startSec {
                LiveButton(tooltip: "Play from \(MeetingsFormat.clock(start))", action: { play(start) }) {
                    Text(verbatim: MeetingsFormat.clock(start)).font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(KitPalette.renamed)
                }
                .frame(width: 58, alignment: .trailing)
                .accessibilityLabel("Play from \(MeetingsFormat.clock(start))")
            } else {
                Color.clear.frame(width: 58)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: line.speaker.isEmpty ? "Unknown voice" : line.speaker)
                    .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
                LineText(text: line.text)
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .liveRow()
        // One element per line (time, voice, text) with Play, instead of a node per text and button.
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Play") { if let start = line.startSec { play(start) } }
    }
}

/// A transcript line's text, selectable while its row is live (under the pointer). A resting row holds plain text:
/// selectable text on all 274 lines gave an accessibility client a text node with links and paths to walk per line.
private struct LineText: View {
    let text: String
    @Environment(\.rowLive) private var live

    var body: some View {
        if live {
            plain.textSelection(.enabled)
        } else {
            plain
        }
    }

    private var plain: some View {
        Text(verbatim: text).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
    }
}

struct FilterField: View {
    @Binding var text: String
    let prompt: String
    var focused: FocusState<Bool>.Binding

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "line.3.horizontal.decrease").foregroundStyle(.secondary).font(.system(size: 11))
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .focused(focused)
                .onExitCommand { text = "" }
            if !text.isEmpty {
                IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the filter (Esc)", size: 11) { text = "" }
            }
        }
        .frame(height: 18)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { focused.wrappedValue = true }
        .background {
            Button("Find") { focused.wrappedValue = true }
                .keyboardShortcut("f", modifiers: .command)
                .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
        }
    }
}

// MARK: - Screen

/// The screen recording as a timeline: every kept frame in time order with the OCR lines that changed since the same
/// display's earlier frame. A display filter on top; a click on a frame shows it large with those lines boxed.
struct ScreenTab: View {
    @Bindable var detail: MeetingDetailModel
    @State private var display: Int = -1
    @State private var opened: TimelineFrame?
    @State private var hideQuiet = true

    var body: some View {
        if detail.record.value?.recording?.frames ?? 0 == 0, detail.record.value != nil {
            EmptyState(symbol: "rectangle.on.rectangle.slash", text: "This meeting has no screen recording",
                       detail: "A recording started with the meeting takes a frame when the screen changes.",
                       actionTitle: "Recording settings…") { FeatureSettingsLaunch.open(pageID: MeetingsSettingsPages.recordingPage) }
        } else {
            LoadablePane(state: detail.timeline, reading: "Reading the screen timeline…", retry: detail.loadTimeline) { timeline in
                VStack(spacing: 0) {
                    // Wraps in a narrow column: in one row the display tabs, the checkbox and the count needed about
                    // 560 pt and ran past the window at its smallest size.
                    WrapLayout(spacing: 12, lineSpacing: 8) {
                        if timeline.displays.count > 1 {
                            GenSegmentedTabs("Display", items: [GenSegmentedTabs.Item(-1, "All displays")] + timeline.displays.map {
                                GenSegmentedTabs.Item($0.id ?? 0, $0.name ?? "Display \($0.id ?? 0)")
                            }, selection: $display, minSegmentWidth: 70, identifier: "meetings.screen.display")
                        }
                        Toggle("Only frames with new text", isOn: $hideQuiet).toggleStyle(.checkbox).font(.system(size: 12))
                            .fixedSize()
                            .instantTooltip("Leave out the frames whose text the display already showed")
                        Text(verbatim: Plural.count(frames(timeline).count, "frame")).font(.system(size: 11).monospacedDigit())
                            .foregroundStyle(.secondary).lineLimit(1).fixedSize()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    Divider()
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(frames(timeline)) { frame in
                                FrameRow(frame: frame, displayName: name(of: frame, in: timeline),
                                         showAll: MeetingsPreferences.timelineLines() == .all) { opened = frame }
                                    .equatable()
                            }
                        }
                        .padding(14)
                    }
                }
                .sheet(item: $opened) { frame in
                    FrameViewer(frame: frame) { opened = nil }
                }
            }
        }
    }

    private func frames(_ timeline: ScreenTimeline) -> [TimelineFrame] {
        timeline.frames.filter { (display == -1 || $0.displayId == display) && (!hideQuiet || !$0.changed.isEmpty) }
    }

    private func name(of frame: TimelineFrame, in timeline: ScreenTimeline) -> String {
        guard let id = frame.displayId else { return "Screen" }
        return timeline.displays.first { $0.id == id }?.name ?? "Display \(id)"
    }
}

private struct FrameRow: View, Equatable {
    let frame: TimelineFrame
    let displayName: String
    let showAll: Bool
    let open: () -> Void

    nonisolated static func == (a: FrameRow, b: FrameRow) -> Bool {
        a.frame == b.frame && a.displayName == b.displayName && a.showAll == b.showAll
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // A resting row has no responder; a click on the thumbnail still opens it (`pressable`).
            LiveButton(tooltip: "Show this frame large, with the changed lines boxed", pressable: true, action: open) {
                FrameThumbnail(path: frame.path, width: 220)
            }
            .accessibilityLabel("Frame at \(MeetingsFormat.clock(frame.meetingSec)) on \(displayName)")
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(verbatim: MeetingsFormat.clock(frame.meetingSec)).font(.system(size: 12, weight: .semibold, design: .monospaced))
                    Text(verbatim: displayName).font(.system(size: 11)).foregroundStyle(.secondary)
                    Text(verbatim: frame.changed.isEmpty ? "no new text" : Plural.count(frame.changed.count, "changed line"))
                        .font(.system(size: 11)).foregroundStyle(.tertiary)
                }
                let lines = showAll ? (frame.lines ?? frame.changed) : frame.changed
                ForEach(Array(lines.prefix(14).enumerated()), id: \.offset) { _, line in
                    Text(verbatim: line.text).font(.system(size: 12)).lineLimit(1).textSelection(.enabled)
                }
                if lines.count > 14 {
                    Text(verbatim: "\(lines.count - 14) more lines").font(.system(size: 11)).foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.bottom, 6)
        .contentShape(Rectangle())
        .liveRow()
        .accessibilityAction(named: "Show large", open)
    }
}

/// A frame drawn at its full width in a sheet, with the changed lines boxed in the frame's own pixels.
private struct FrameViewer: View {
    let frame: TimelineFrame
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(verbatim: "Frame at \(MeetingsFormat.clock(frame.meetingSec))").font(.system(size: 14, weight: .semibold))
                Text(verbatim: Plural.count(frame.changed.count, "changed line")).foregroundStyle(.secondary).font(.system(size: 12))
                Spacer()
                Button("Show in Finder") { PathOpener.reveal(frame.path) }.buttonStyle(.genHoverPlain())
                Button("Close", action: close).keyboardShortcut(.cancelAction)
            }
            GeometryReader { proxy in
                let scale = min(proxy.size.width / max(frame.width, 1), proxy.size.height / max(frame.height, 1))
                ZStack(alignment: .topLeading) {
                    FrameThumbnail(path: frame.path, width: frame.width * scale)
                    ForEach(Array(frame.changed.enumerated()), id: \.offset) { _, box in
                        Rectangle().strokeBorder(Color.accentColor, lineWidth: 1.5)
                            .frame(width: box.width * scale, height: box.height * scale)
                            .offset(x: box.x * scale, y: box.y * scale)
                            .accessibilityLabel(box.text)
                    }
                }
                .frame(width: frame.width * scale, height: frame.height * scale)
            }
        }
        .padding(16)
        // Smaller than the window's own minimum, so the sheet never hangs past a small window.
        .frame(minWidth: 640, minHeight: 420)
    }
}

/// A frame file drawn from a thumbnail made off the main thread and kept in a small cache.
struct FrameThumbnail: View {
    let path: String
    let width: CGFloat
    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
            } else {
                Rectangle().fill(.white.opacity(0.05)).aspectRatio(16 / 10, contentMode: .fit)
                    .overlay { Image(systemName: "photo").foregroundStyle(.tertiary) }
            }
        }
        .frame(width: width)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .task(id: "\(path)@\(Int(width))") {
            image = await FrameThumbnails.shared.image(path: path, maxPixel: Int(width * 2))
        }
    }
}

actor FrameThumbnails {
    static let shared = FrameThumbnails()
    private let cache = NSCache<NSString, NSImage>()

    init() { cache.countLimit = 160 }

    func image(path: String, maxPixel: Int) -> NSImage? {
        let key = "\(path)@\(maxPixel)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxPixel,
                  kCGImageSourceCreateThumbnailWithTransform: true,
              ] as CFDictionary) else { return nil }
        let image = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
        cache.setObject(image, forKey: key)
        return image
    }
}

// MARK: - Items

/// The items a person decides: open questions and suggestions first (in transcript order), then the decided ones,
/// folded. Each decision leaves a note with Undo for the window's undo time.
struct ItemsTab: View {
    @Bindable var detail: MeetingDetailModel
    @State private var showDecided = false
    /// The keyboard's row: Up and Down move it, Return confirms, Delete rejects; its buttons stay live.
    @State private var selected: String?

    var body: some View {
        LoadablePane(state: detail.record, reading: "Reading the items…", retry: detail.reloadRecord) { record in
            let questions = record.items.filter { $0.kind == "question" && $0.status == "suggested" }
            let suggested = record.items.filter { $0.kind != "question" && $0.status == "suggested" }
                .sorted { ($0.seconds ?? 0) < ($1.seconds ?? 0) }
            let decided = record.items.filter { $0.status != "suggested" }
            if record.items.isEmpty {
                let hasTranscript = detail.window?.meeting(record.id)?.hasTranscript ?? true
                EmptyState(symbol: "checklist", text: "No items yet",
                           detail: hasTranscript ? "The rules suggest items from the transcript." : "The rules need a transcript, and this meeting has none.",
                           actionTitle: !hasTranscript ? nil : detail.isBusy("suggest") ? "Suggesting…" : "Suggest items") { detail.suggest() }
            } else {
                List(selection: $selected) {
                    if !questions.isEmpty {
                        Section("Questions to answer (\(questions.count))") {
                            ForEach(questions) { item in
                                QuestionRow(item: item, busy: detail.isBusy("answer.\(item.id)"),
                                            play: { detail.play(at: $0) }, answer: { detail.answer(item, with: $0) })
                            }
                        }
                    }
                    Section(suggested.isEmpty ? "No suggestion waits" : "Suggested (\(suggested.count))") {
                        ForEach(suggested) { item in
                            ItemRow(item: item, busy: detail.busyItems.contains(item.id), selected: selected == item.id,
                                    play: { detail.play(at: $0) },
                                    decide: { confirm, speaker in detail.decide(item, confirm: confirm, speaker: speaker) },
                                    reopen: nil)
                                .equatable()
                                .tag(item.id)
                        }
                    }
                    if !decided.isEmpty {
                        Section {
                            if showDecided {
                                ForEach(decided) { item in
                                    ItemRow(item: item, busy: detail.isBusy("reopen.\(item.id)"), selected: selected == item.id,
                                            play: { detail.play(at: $0) },
                                            decide: nil, reopen: item.kind == "question" ? nil : { detail.reopen(item, token: nil) })
                                        .equatable()
                                        .tag(item.id)
                                }
                            }
                        } header: {
                            Button {
                                showDecided.toggle()
                            } label: {
                                Label("Decided (\(decided.count))", systemImage: showDecided ? "chevron.down" : "chevron.right")
                                    .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }
                            .buttonStyle(.genHoverPlain())
                            .accessibilityValue(showDecided ? "Expanded" : "Collapsed")
                        }
                    }
                }
                .listStyle(.inset)
                .safeAreaInset(edge: .top, spacing: 0) {
                    BulkConfirmBar(detail: detail, items: record.items,
                                   applyAbove: detail.window?.overview.value?.applyAbove ?? 0.5)
                }
                .onKeyPress(.return) { act(on: record, confirm: true) }
                .onKeyPress(.delete) { act(on: record, confirm: false) }
            }
        }
    }

    /// Return confirms and Delete rejects the selected suggestion (a range with no speaker waits for its menu).
    private func act(on record: MeetingRecordView, confirm: Bool) -> KeyPress.Result {
        guard let id = selected, let item = record.items.first(where: { $0.id == id }), item.status == "suggested",
              item.kind != "question", !(confirm && item.kind == "speaker-range" && item.speaker == nil) else { return .ignored }
        detail.decide(item, confirm: confirm)
        return .handled
    }
}

/// Above the items: how many suggestions are at the apply line, and one menu that confirms all of them at or above a
/// line, with one Undo. Before it every suggestion took its own click, 40 of them in a long meeting.
private struct BulkConfirmBar: View {
    let detail: MeetingDetailModel
    let items: [MeetingItem]
    /// The config's apply line (`assign.applyAbove`), the default threshold.
    let applyAbove: Double

    var body: some View {
        let waiting = items.filter { $0.status == "suggested" && $0.kind != "question" }
        if !waiting.isEmpty {
            let atLine = MeetingDetailModel.confirmable(items, atOrAbove: applyAbove).count
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Text(atLine > 0
                         ? "\(Plural.count(atLine, "suggestion")) at \(pct(applyAbove)) or more"
                         : "No suggestion at \(pct(applyAbove)) or more")
                        .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 8)
                    MenuButton(items: { menu() }) {
                        Label("Confirm all…", systemImage: "checkmark.circle").font(.system(size: 12))
                    }
                    .disabled(detail.isBusy("confirm.all"))
                    .instantTooltip("Confirm every suggestion at or above a confidence, with one Undo")
                    .accessibilityIdentifier("meetings.items.confirmAll")
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
                Divider()
            }
            .background(.background)
        }
    }

    private func pct(_ value: Double) -> String { MeetingsWords.confidence(value) ?? "" }

    private func menu() -> [MenuButtonItem] {
        var lines = [0.9, 0.8]
        if !lines.contains(applyAbove), applyAbove > 0 { lines.append(applyAbove) }
        var menu: [MenuButtonItem] = [.note("Confirm every suggestion at or above")]
        for line in lines.sorted(by: >) {
            let count = MeetingDetailModel.confirmable(items, atOrAbove: line).count
            let mark = line == applyAbove ? " (the apply line)" : ""
            menu.append(.action("\(pct(line))\(mark): \(Plural.count(count, "item"))", enabled: count > 0) {
                detail.confirmAll(atOrAbove: line)
            })
        }
        let every = MeetingDetailModel.confirmable(items, atOrAbove: 0).count
        menu.append(.action("Any confidence: \(Plural.count(every, "item"))", enabled: every > 0) { detail.confirmAll(atOrAbove: 0) })
        menu.append(.divider)
        menu.append(.note("Questions, ranges with no speaker and terms with no spelling stay for you."))
        return menu
    }
}

private struct ItemRow: View, Equatable {
    let item: MeetingItem
    let busy: Bool
    var selected = false
    let play: (Double) -> Void
    let decide: ((Bool, String?) -> Void)?
    let reopen: (() -> Void)?

    /// The item, the spinner, the selection and which buttons it has; the closures never compare equal, so only their
    /// presence counts.
    nonisolated static func == (a: ItemRow, b: ItemRow) -> Bool {
        MainActor.assumeIsolated {
            a.item == b.item && a.busy == b.busy && a.selected == b.selected
                && (a.decide == nil) == (b.decide == nil) && (a.reopen == nil) == (b.reopen == nil)
        }
    }

    private var needsSpeaker: Bool { item.kind == "speaker-range" && item.speaker == nil }
    private var needsSpelling: Bool { item.needsSpelling }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(MeetingsWords.itemKind(item)).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    if let seconds = item.seconds {
                        LiveButton(tooltip: "Play from \(MeetingsFormat.clock(seconds))", action: { play(seconds) }) {
                            Text(verbatim: MeetingsFormat.clock(seconds)).font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(KitPalette.renamed)
                        }
                    }
                    if let confidence = MeetingsWords.confidence(item.confidence) {
                        Text(verbatim: confidence).font(.system(size: 11).monospacedDigit()).foregroundStyle(.tertiary)
                    }
                    if item.status != "suggested" {
                        Badge(MeetingsWords.status(item.status), color: item.status == "confirmed" ? KitPalette.added : KitPalette.faint)
                    }
                }
                Text(verbatim: MeetingsWords.itemTitle(item)).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
                if let reason = item.reason {
                    Text(verbatim: reason).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(3)
                }
            }
            Spacer(minLength: 8)
            if busy {
                ProgressView().controlSize(.small)
            } else if let decide {
                HStack(spacing: 6) {
                    if needsSpeaker {
                        MenuButton(items: {
                            (item.candidates ?? []).map { name in .action(name) { decide(true, name) } }
                                + ((item.candidates ?? []).isEmpty ? [.note("No candidate: answer it in a terminal with --speaker")] : [])
                        }) {
                            Text("Confirm as…").font(.system(size: 12))
                        }
                        .instantTooltip("Whose voice this range is; confirming needs a name")
                    } else {
                        LiveButton(tooltip: needsSpelling ? "It has no spelling yet: answer it by ear" : "Confirm: transcripts apply it",
                                   enabled: !needsSpelling, action: { decide(true, nil) }) {
                            Text("Confirm").font(.system(size: 12))
                        }
                    }
                    LiveButton(tooltip: "Reject: it is never suggested again", action: { decide(false, nil) }) {
                        Text("Reject").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
            } else if let reopen {
                LiveButton(tooltip: "Put it back to suggested", action: reopen) {
                    Text("Reopen").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .liveRow(selected: selected)
        // One element per item with its actions, instead of a node per text, badge and button: with 425 suggestions a
        // walk ran out of its budget after 887 nodes (2026-11-06).
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Confirm") { if let decide, !needsSpeaker, !needsSpelling { decide(true, nil) } }
        .accessibilityAction(named: "Reject") { decide?(false, nil) }
        .accessibilityAction(named: "Reopen") { reopen?() }
        .accessibilityAction(named: "Play") { if let seconds = item.seconds { play(seconds) } }
        .accessibilityActions {
            if needsSpeaker, let decide {
                ForEach(item.candidates ?? [], id: \.self) { name in
                    Button("Confirm as \(name)") { decide(true, name) }
                }
            }
        }
    }
}

private struct QuestionRow: View {
    let item: MeetingItem
    let busy: Bool
    let play: (Double) -> Void
    let answer: (String) -> Void
    @State private var typed = ""
    @AppStorage(MeetingsPreferences.typedAnswerKey) private var typedAnswer = MeetingsPreferences.TypedAnswer.always.rawValue

    private var showsField: Bool {
        (MeetingsPreferences.TypedAnswer(rawValue: typedAnswer) ?? .always).shows(choices: item.choices ?? [])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "ear").foregroundStyle(KitPalette.renamed).font(.system(size: 11))
                    .accessibilityHidden(true)
                Text(verbatim: item.question ?? "").font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
            }
            WrapLayout(spacing: 6, lineSpacing: 6) {
                if let from = item.fromSec {
                    GhostButton("Play \(MeetingsFormat.clock(from))", symbol: "play.fill", tooltip: "Play the asked range in the meetings player") {
                        play(from)
                    }
                }
                ForEach(item.choices ?? [], id: \.self) { choice in
                    GhostButton(choice, symbol: "checkmark", tooltip: "Answer “\(choice)”; it decides the items this question settles") {
                        answer(choice)
                    }
                    .disabled(busy)
                }
                GhostButton("None of these", symbol: "xmark", tooltip: "None of the choices is right; what it decides is rejected") {
                    answer("none of these")
                }
                .disabled(busy)
                if busy { ProgressView().controlSize(.small) }
            }
            if showsField {
                HStack(spacing: 6) {
                    TextField(item.choices?.isEmpty == false ? "Or type what you heard" : "Type what you heard", text: $typed)
                        .textFieldStyle(.roundedBorder).frame(maxWidth: 260)
                        .onSubmit(submit)
                        .accessibilityLabel("Answer to: \(item.question ?? "the question")")
                    GhostButton("Answer", symbol: "return", tooltip: "Answer with the typed text; it decides the items this question settles") {
                        submit()
                    }
                    .disabled(busy || MeetingsWords.typedAnswer(typed) == nil)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func submit() {
        guard !busy, let text = MeetingsWords.typedAnswer(typed) else { return }
        answer(text)
        typed = ""
    }
}

// MARK: - Speakers

/// Each label of the transcript with its turns and spoken time; a rename edits in place and commits on Return.
struct SpeakersTab: View {
    @Bindable var detail: MeetingDetailModel

    var body: some View {
        LoadablePane(state: detail.speakers, reading: "Reading the speakers…", retry: detail.loadSpeakers,
                     noSource: detail.noTranscriptSource("speakers")) { stats in
            if stats.speakers.isEmpty {
                EmptyState(symbol: "person.2", text: "No speaker yet", detail: "The speakers come from the transcript.")
            } else {
                let renames = detail.record.value?.speakers.labels ?? [:]
                List(stats.speakers) { speaker in
                    SpeakerRow(speaker: speaker, rename: renames[speaker.label]) { detail.rename(label: speaker.label, to: $0) }
                }
                .listStyle(.inset)
            }
        }
    }
}

private struct SpeakerRow: View {
    let speaker: SpeakerStat
    let rename: String?
    let commit: (String) -> Void
    @State private var name = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: speaker.label).font(.system(size: 13, weight: .medium))
                Text(verbatim: [Plural.count(speaker.turns, "turn"), MeetingsFormat.length(speaker.spokenSec).map { "\($0) spoken" },
                                MeetingsWords.origin(speaker.origin)].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 11.5)).foregroundStyle(.secondary)
            }
            Spacer()
            TextField("Rename", text: $name, prompt: Text(rename ?? "Rename for this meeting"))
                .textFieldStyle(.roundedBorder).frame(width: 220)
                .focused($focused)
                .onSubmit { commit(name) }
                .onExitCommand { name = rename ?? ""; focused = false }
                .accessibilityLabel("Rename \(speaker.label)")
        }
        .padding(.vertical, 3)
        .onAppear { name = rename ?? "" }
        .onChange(of: rename) { _, value in if !focused { name = value ?? "" } }
    }
}

// MARK: - Context

/// The meeting's reference material: files (kept as their paths), links and notes. Drop files on the pane to add them;
/// the pane draws its drop target while a drag is over it.
struct ContextTab: View {
    @Bindable var detail: MeetingDetailModel
    @State private var targeted = false

    var body: some View {
        LoadablePane(state: detail.record, reading: "Reading the context…", retry: detail.reloadRecord) { record in
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Files, links and notes the transcript rules read (quotes, meanings).")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer()
                    GhostButton("Add files…", symbol: "plus", tooltip: "Choose files to add as context (or drop them here)") {
                        let panel = NSOpenPanel()
                        panel.allowsMultipleSelection = true
                        panel.canChooseDirectories = false
                        panel.prompt = "Add"
                        if panel.runModal() == .OK { detail.addContext(paths: panel.urls.map(\.path)) }
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 8)
                Divider()
                if record.context.isEmpty {
                    EmptyState(symbol: "doc.on.doc", text: "No context yet", detail: "Drop a file here, or use Add files.")
                } else {
                    List(record.context) { ref in
                        HStack(spacing: 10) {
                            Image(systemName: ref.kind == "file" ? "doc" : ref.kind == "url" ? "link" : "note.text")
                                .foregroundStyle(.secondary).accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: MeetingsWords.contextTitle(ref)).font(.system(size: 13))
                                if ref.kind == "file" {
                                    PathLabel(path: ref.ref, font: .system(size: 10.5, design: .monospaced), showIcons: false)
                                } else if ref.kind == "url" {
                                    Text(verbatim: ref.ref).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                                }
                                if let note = ref.note {
                                    Text(verbatim: note).font(.system(size: 11.5)).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            IconButton(systemName: "trash", tooltip: "Remove \(MeetingsWords.contextTitle(ref)) from this meeting's context") {
                                detail.removeContext(ref)
                            }
                        }
                        .padding(.vertical, 2)
                        .liveRow()
                    }
                    .listStyle(.inset)
                }
            }
        }
        .overlay {
            if targeted {
                RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor, lineWidth: 2)
                    .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                    .overlay { Text("Drop to add as context").font(.system(size: 13, weight: .medium)) }
                    .padding(6)
                    .allowsHitTesting(false)
            }
        }
        .onDrop(of: [.fileURL], isTargeted: $targeted) { providers in
            Task { @MainActor in
                var paths: [String] = []
                for provider in providers {
                    if let url = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) as? Data,
                       let file = URL(dataRepresentation: url, relativeTo: nil) {
                        paths.append(file.path)
                    }
                }
                if !paths.isEmpty { detail.addContext(paths: paths) }
            }
            return true
        }
    }
}
