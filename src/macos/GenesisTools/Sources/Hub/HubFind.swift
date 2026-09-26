import AppKit
import SwiftUI

// ⌘⇧F: find in files. `rg` over the selected project (and any folder added in Files) off the main
// thread; hits stream in batches, capped at `maxHits`; a new query stops the running search. A hit
// opens in the Changes pane when that file has changes there, otherwise in Cursor at its line.

struct HubFindHit: Identifiable, Hashable {
    let path: String
    let line: Int
    let text: String
    var id: String { "\(path):\(line)" }
}

@MainActor
final class HubFindModel: ObservableObject {
    static let maxHits = 1000

    @Published var query = ""
    @Published private(set) var hits: [HubFindHit] = []
    @Published private(set) var running = false
    @Published private(set) var truncated = false
    @Published private(set) var note: String?

    private var process: Process?
    private var generation = 0

    /// rg from Homebrew or /usr/local; nil sends the search through `grep -rn` instead.
    private static let rg: String? = ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"].first { FileManager.default.isExecutableFile(atPath: $0) }

    func search(roots: [String]) {
        stop()
        generation += 1
        let token = generation
        hits = []
        truncated = false
        note = nil
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty, !roots.isEmpty else { return }

        let process = Process()
        if let rg = Self.rg {
            process.executableURL = URL(fileURLWithPath: rg)
            process.arguments = ["--line-number", "--no-heading", "--smart-case", "--fixed-strings", "--max-columns", "300",
                                 "--max-columns-preview", "--max-count", "50", "--", needle] + roots
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/grep")
            process.arguments = ["-rnIF", "--exclude-dir=.git", "--exclude-dir=node_modules", "--", needle] + roots
        }
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        let span = HubPerf.begin("find.search", "\(needle.count) chars, \(roots.count) roots")
        var buffer = Data()
        var pending: [HubFindHit] = []
        var total = 0
        var lastFlush = Date()

        // One reader owns the buffers; end of output (the process finished or was stopped) is the
        // final flush, so no line is lost to a termination callback that runs first.
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                let rest = pending
                pending = []
                DispatchQueue.main.async {
                    guard let self, self.generation == token else { return }
                    self.hits.append(contentsOf: rest.prefix(max(0, Self.maxHits - self.hits.count)))
                    self.running = false
                    self.process = nil
                    span.end("\(self.hits.count) hits")
                    if self.hits.isEmpty {
                        self.note = "No matches for “\(needle)”"
                    }
                }
                return
            }
            buffer.append(chunk)
            let found = Self.drain(&buffer, room: Self.maxHits - total)
            pending += found
            total += found.count
            let full = total >= Self.maxHits
            if full {
                // The cap is reached here, on the reader: nothing more is parsed or kept, and the
                // search stops now, so one large chunk from a fast rg cannot grow the buffers while
                // the main queue catches up. No end-of-output read follows, so the main block ends it.
                buffer = Data()
                handle.readabilityHandler = nil
                if process.isRunning {
                    process.terminate()
                }
            }
            if full || pending.count >= 60 || Date().timeIntervalSince(lastFlush) > 0.1 {
                let batch = pending
                pending = []
                lastFlush = Date()
                DispatchQueue.main.async {
                    guard let self, self.generation == token else { return }
                    self.hits.append(contentsOf: batch.prefix(max(0, Self.maxHits - self.hits.count)))
                    if full {
                        self.truncated = true
                        self.stop()
                        span.end("\(self.hits.count) hits, capped")
                    }
                }
            }
        }
        do {
            try process.run()
            self.process = process
            running = true
        } catch {
            span.end("failed")
            note = "Could not run the search: \(error.localizedDescription)"
        }
    }

    func stop() {
        if let process, process.isRunning {
            process.terminate()
        }
        process = nil
        running = false
    }

    /// Parses whole lines off the front of `buffer` until `room` hits are found; the unread rest (and a
    /// partial last line) stays in `buffer`. One removal per call, not one per line.
    nonisolated static func drain(_ buffer: inout Data, room: Int) -> [HubFindHit] {
        var hits: [HubFindHit] = []
        var start = buffer.startIndex
        while hits.count < room, let newline = buffer[start...].firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[start..<newline], as: UTF8.self)
            start = buffer.index(after: newline)
            if let hit = parse(line) {
                hits.append(hit)
            }
        }
        buffer.removeSubrange(buffer.startIndex..<start)
        return hits
    }

    /// `path:line:text` (rg --no-heading, grep -n). A path with a colon is rare enough to accept.
    nonisolated static func parse(_ line: String) -> HubFindHit? {
        let parts = line.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, let number = Int(parts[1]) else { return nil }
        return HubFindHit(path: String(parts[0]), line: number, text: String(parts[2]).trimmingCharacters(in: .whitespaces))
    }
}

struct HubFindPanel: View {
    @ObservedObject var hub: HubModel
    let roots: [String]
    @StateObject private var find = HubFindModel()
    @FocusState private var focused: Bool

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .onTapGesture { close() }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "text.magnifyingglass").foregroundColor(Color.jarvisTeal)
                    TextField("Find in files", text: $find.query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13, design: .monospaced))
                        .focused($focused)
                        .onSubmit { find.search(roots: roots) }
                        .accessibilityIdentifier("hub-find-input")
                    // A fixed slot: the field and the hit count keep their places while a search runs.
                    HStack(spacing: 6) {
                        if find.running {
                            ProgressView().controlSize(.small)
                            IconButton(systemName: "stop.circle", tooltip: "Stop the search") { find.stop() }
                        }
                    }
                    .frame(width: 40, alignment: .trailing)
                    Text(verbatim: find.truncated ? "\(find.hits.count)+ hits" : "\(find.hits.count) hits")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.settingsTextMuted)
                }
                .padding(12)
                HStack(spacing: 6) {
                    Text("In").font(.system(size: 11)).foregroundColor(.settingsTextMuted)
                    ForEach(roots, id: \.self) { root in
                        PathLabel(path: root, font: .system(size: 11, design: .monospaced), showIcons: false)
                    }
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                Divider().background(Color.jarvisBorder)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if let note = find.note {
                            Text(verbatim: note).foregroundColor(.settingsTextMuted).padding(16)
                        }
                        ForEach(groups, id: \.path) { group in
                            Text(verbatim: display(group.path))
                                .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                                .foregroundColor(.settingsText)
                                .textSelection(.enabled)
                                .contextMenu {
                                    Button("Copy path") { PathOpener.copy(group.path, what: "path") }
                                    Button("Reveal in Finder") { PathOpener.reveal(group.path) }
                                    Button("Open in Cursor") { PathOpener.cursor(group.path) }
                                }
                                .padding(.horizontal, 12)
                                .padding(.top, 8)
                                .padding(.bottom, 2)
                            ForEach(group.hits) { hit in
                                Button { open(hit) } label: {
                                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                                        Text(verbatim: "\(hit.line)")
                                            .font(.system(size: 10.5, design: .monospaced))
                                            .foregroundColor(.settingsTextMuted)
                                            .frame(width: 44, alignment: .trailing)
                                        Text(verbatim: hit.text)
                                            .font(.system(size: 11.5, design: .monospaced))
                                            .foregroundColor(Color.white.opacity(0.8))
                                            .lineLimit(1)
                                            .truncationMode(.tail)
                                        Spacer(minLength: 0)
                                    }
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 3)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 4))
                                .instantTooltip("Open \(display(hit.path)):\(hit.line)")
                            }
                        }
                    }
                    .padding(.bottom, 8)
                }
                .frame(maxHeight: 460)
            }
            .frame(width: 760)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.settingsBackground))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.jarvisTeal.opacity(0.28), lineWidth: 1))
            .padding(.top, 70)
        }
        .onAppear {
            find.query = hub.findQuery ?? ""
            focused = true
            if !find.query.isEmpty {
                find.search(roots: roots)
            }
        }
        .onDisappear { find.stop() }
        .onExitCommand { close() }
        .panelFindModal()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Find in files"))
    }

    private var groups: [(path: String, hits: [HubFindHit])] {
        var order: [String] = []
        var byPath: [String: [HubFindHit]] = [:]
        for hit in find.hits {
            if byPath[hit.path] == nil {
                order.append(hit.path)
            }
            byPath[hit.path, default: []].append(hit)
        }
        return order.map { ($0, byPath[$0] ?? []) }
    }

    private func display(_ path: String) -> String {
        for root in roots where path.hasPrefix(root + "/") {
            return String(path.dropFirst(root.count + 1))
        }
        return path
    }

    private func open(_ hit: HubFindHit) {
        HubPerf.log("find.open \(display(hit.path)):\(hit.line)")
        // A hit in any ticked root that has a change opens in the diff; anything else opens in Cursor.
        if let review = hub.review, review.file(atPath: hit.path) != nil {
            if !hub.panes.contains(.changes) {
                hub.togglePane(.changes)
            }
            review.reveal(path: hit.path)
            close()
            return
        }
        PathOpener.cursor(hit.path, line: hit.line)
    }

    private func close() {
        find.stop()
        hub.findQuery = nil
    }
}
