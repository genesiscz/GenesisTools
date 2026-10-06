import AppKit
import Combine
import GenesisKit
import UniformTypeIdentifiers

enum RecastWorkspaceMode: String, CaseIterable, Identifiable {
    case split = "Split", source = "Source", objects = "Objects", destination = "Destination"
    var id: String { rawValue }
    func effective(width: CGFloat) -> Self { self == .split && width < 1050 ? .objects : self }
}

enum RecastExample: String, CaseIterable, Identifiable {
    case journey = "ambiguous-journey", screenshot = "screenshot-spec"
    var id: String { rawValue }
    var label: String { self == .journey ? "Try an invented timetable" : "Try an invented screenshot spec" }
}

@MainActor
final class RecastModel: ObservableObject {
    @Published var file: RecastFile?
    @Published var busy = false
    @Published var progress = ""
    @Published var error: String?
    @Published var notice: String?
    @Published var workspaceMode: RecastWorkspaceMode = .split
    var workspaceWidth: CGFloat = 1460
    @Published var selectedSource = "" { didSet { if oldValue != selectedSource { page = 0; selectedRegion = nil; loadPreview() } } }
    @Published var selectedCollection = "" {
        didSet {
            if oldValue != selectedCollection {
                rendering = nil
                exportFormat = collection?.kind == "calendar" ? "ics" : "csv"
                bulkRecordIDs = []
                invalidateProposal()
            }
        }
    }
    @Published var selectedRecord = ""
    @Published var bulkRecordIDs: Set<String> = []
    @Published var bulkDraft: RecastBulkDraft?
    @Published var showBulkSheet = false
    @Published var correctionExamples: RecastCorrectionPreview?
    @Published var correctionExampleScope: RecastEvidenceScope?
    @Published var showCorrectionExamples = false
    @Published var selectedField = ""
    @Published var selectedAnchor = ""
    @Published var page = 0 { didSet { if oldValue != page { selectedRegion = nil; loadPreview() } } }
    @Published var selectedRegion: NativeSourceRect?
    @Published var textSelection = NSRange(location: 0, length: 0)
    let audio = NativeAudioPlayback()
    @Published var audioTranscript: RecastTranscriptReview?
    @Published var sourceImage: NSImage?
    @Published var sourceText = ""
    @Published var sourceTextOffset = 0
    @Published var previewBusy = false
    @Published var rendering: RecastRendering?
    @Published var exportFormat = "csv"
    @Published var exportIncludeRecordIDs = true
    @Published var showExport = false
    @Published var showCollectionEditor = false
    @Published var showRegionEditor = false
    @Published var evidenceDraft: RecastEvidenceDraft?
    @Published var showEvidenceSheet = false
    @Published var contradictionDraft: RecastContradictionDraft?
    @Published var showContradictionSheet = false
    @Published var showAIProposal = false
    @Published var proposalReadingIDs: Set<String> = [] {
        didSet { if oldValue != proposalReadingIDs { invalidateProposal() } }
    }
    var proposalRequestID = UUID()
    var proposalPreviewReady = false
    @Published var proposal: RecastProposalReview?
    @Published var roundTrip: RecastRoundTripDraft?
    @Published var showRoundTrip = false
    @Published var showReconciliation = false
    @Published var reconciliationJobId: String?
    @Published var reconciliationPreview: RecastReconciliationPreview?
    var evidenceWindows: [RecastEvidenceWindowController] = []
    @Published var issues: [RecastIssue] = []
    var assets: [String: Data] = [:]
    weak var owner: RecastDocument?
    var onReady: (() -> Void)?
    private let bridge: ToolsBridge
    private let generationBridge: ToolsBridge
    private let sourceRoot: URL
    private var task: Task<Void, Never>?
    private var previewTask: Task<Void, Never>?
    private var audioReadiness: AnyCancellable?
    private var epoch = UUID()
    private var closed = false
    private var inferenceCheckpoint: RecastInferenceCheckpoint?

    init(toolsPath: String) {
        bridge = ToolsBridge(binaryPath: toolsPath)
        let root = URL(fileURLWithPath: toolsPath).resolvingSymlinksInPath().deletingLastPathComponent()
        sourceRoot = root
        generationBridge = ToolsBridge(binaryPath: root.appendingPathComponent("src/recast/index.ts").path)
        audioReadiness = audio.$isLoading.dropFirst().filter { !$0 }.sink { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, !self.closed, !self.busy, self.file != nil else { return }
                self.onReady?()
            }
        }
    }
    var collection: RecastCollection? { file?.collections.first { $0.id == selectedCollection } }
    var source: RecastSource? { file?.sources.first { $0.id == selectedSource } }
    var records: [RecastRecord] { file?.records.filter { $0.collectionId == selectedCollection && $0.state != "archived" } ?? [] }
    var record: RecastRecord? { file?.records.first { $0.id == selectedRecord } }
    var field: RecastField? { collection?.fields.first { $0.id == selectedField } }
    var cell: RecastCell? { record?.cells[selectedField] }
    var sourceAnchors: [RecastAnchor] { file?.anchors.filter { $0.sourceId == selectedSource } ?? [] }
    var pageCount: Int {
        guard let source else { return 1 }
        if source.kind == "text" { return max(1, Int(ceil(Double(source.textLength ?? 0) / 32000))) }
        return max(1, source.pageCount ?? 1)
    }
    var state: RecastState? { file.map { RecastState(file: $0, assets: assets) } }

    func start(kind: String = "table") {
        perform("Creating conversion") { model in
            let answer = try await model.command("new", arguments: ["--kind", kind])
            let file = try JSONDecoder().decode(RecastFile.self, from: Data(answer.utf8))
            model.install(RecastState(file: file, assets: [:]))
        }
    }

    func validateLoaded() {
        guard let file else { return }
        perform("Checking source evidence") { model in
            let inspected = try await model.inspect(file)
            model.file = inspected.document
            model.issues = inspected.issues
            model.normalizeSelection()
            model.loadPreview()
        }
    }

    func install(_ state: RecastState) {
        inferenceCheckpoint = nil
        rendering = nil
        evidenceDraft = nil; showEvidenceSheet = false
        roundTrip = nil; showRoundTrip = false
        audioTranscript = nil
        contradictionDraft = nil; showContradictionSheet = false
        bulkDraft = nil; showBulkSheet = false
        correctionExamples = nil; correctionExampleScope = nil; showCorrectionExamples = false
        file = state.file
        assets = state.assets
        normalizeSelection()
        owner?.displayName = state.file.title
        owner?.windowControllers.first?.window?.title = "Recast · " + state.file.title
    }

    func normalizeSelection() {
        guard let file else { return }
        if !file.collections.contains(where: { $0.id == selectedCollection }) { selectedCollection = file.collections.first?.id ?? "" }
        if !file.sources.contains(where: { $0.id == selectedSource }) { selectedSource = file.sources.first?.id ?? "" }
        if !records.contains(where: { $0.id == selectedRecord }) { selectedRecord = records.first?.id ?? "" }
        if !(collection?.fields.contains { $0.id == selectedField } ?? false) { selectedField = collection?.fields.first?.id ?? "" }
        bulkRecordIDs.formIntersection(Set(records.map(\.id)))
    }

    func perform(_ title: String, work: @escaping @MainActor (RecastModel) async throws -> Void) {
        guard !busy, !closed else { return }
        busy = true; progress = title; error = nil
        let operation = UUID()
        epoch = operation
        task = Task { [weak self] in
            guard let self else { return }
            let span = HubPerf.begin("recast.operation", title, awaits: true)
            defer { span.end() }
            do {
                try await work(self)
                try Task.checkCancellation()
                if epoch == operation { busy = false; progress = ""; onReady?() }
            } catch is CancellationError {
                HubPerf.log("recast: cancelled " + title)
                if epoch == operation { busy = false; progress = ""; notice = "Cancelled. Completed work is preserved." }
            } catch {
                HubPerf.log("recast: \(title) failed: \(error)")
                if epoch == operation { self.error = error.localizedDescription; busy = false; progress = "" }
            }
        }
    }

    func command(_ command: String, file: RecastFile? = nil, operations: [RecastJSON]? = nil, arguments: [String] = [], timeoutSeconds: Int = 60) async throws -> String {
        if ["transcribe", "propose"].contains(command) {
            guard let file else { throw recastError("Choose saved source material before interpretation.") }
            let identity = RecastInferenceCheckpoint(documentId: file.id, revision: file.revision)
            if inferenceCheckpoint != identity { _ = try await checkpointForInference() }
            guard inferenceCheckpoint == identity else { throw recastError("The conversion changed before interpretation. Refresh the selected input.") }
        }
        let prepared = try await Task.detached(priority: .userInitiated) {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("genesis-recast-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            do {
                var args = [String]()
                if let file {
                    let url = folder.appendingPathComponent("manifest.json")
                    try JSONEncoder().encode(file).write(to: url, options: .atomic)
                    args += ["--input", url.path]
                }
                if let operations {
                    let url = folder.appendingPathComponent("operation.json")
                    try JSONEncoder().encode(operations).write(to: url, options: .atomic)
                    args += ["--operation", url.path]
                }
                return (folder, args)
            } catch {
                do { try FileManager.default.removeItem(at: folder) }
                catch { HubPerf.log("recast: temporary input cleanup failed: \(error)") }
                throw error
            }
        }.value
        defer {
            do { try FileManager.default.removeItem(at: prepared.0) }
            catch { HubPerf.log("recast: temporary input cleanup failed: \(error)") }
        }
        try Task.checkCancellation()
        let slot = ["transcribe", "propose"].contains(command) ? try await RecastInferenceSlots.shared.acquire() : nil
        defer { if let slot { Task { await RecastInferenceSlots.shared.release(slot) } } }
        try Task.checkCancellation()
        let answer: ToolsRunResult
        if ["transcribe", "propose"].contains(command) {
            answer = try await generationBridge.run(subcommand: command, args: prepared.1 + arguments, timeoutSeconds: timeoutSeconds)
        } else {
            answer = try await bridge.run(subcommand: "recast", args: [command] + prepared.1 + arguments, timeoutSeconds: timeoutSeconds)
        }
        try Task.checkCancellation()
        guard answer.exitCode == 0 else { throw recastCommandError(command, result: answer) }
        return answer.stdout
    }

    private func inspect(_ file: RecastFile) async throws -> RecastInspection {
        let answer = try await command("inspect", file: file)
        return try JSONDecoder().decode(RecastInspection.self, from: Data(answer.utf8))
    }

    func checkpointForInference(anchor: RecastAnchor? = nil) async throws -> RecastFile {
        if let anchor {
            try await apply([recastOperation("add-anchor", ["anchor": try .encoded(anchor)])], title: "Save selected region")
        }
        guard let before = file else { throw recastError("The conversion has not finished opening.") }
        if let owner { try await owner.persistBeforeInference() }
        try Task.checkCancellation()
        guard !closed, file?.id == before.id, file?.revision == before.revision else {
            throw recastError("The conversion changed during its save. Start the interpretation again.")
        }
        inferenceCheckpoint = RecastInferenceCheckpoint(documentId: before.id, revision: before.revision)
        return before
    }

    func apply(_ operations: [RecastJSON], title: String, addedAssets: [String: Data] = [:]) async throws {
        guard let before = state else { throw recastError("The conversion has not finished opening.") }
        let requestedEpoch = epoch
        let answer = try await command("apply", file: before.file, operations: operations, arguments: ["--revision", String(before.file.revision)])
        let next = try JSONDecoder().decode(RecastFile.self, from: Data(answer.utf8))
        let inspected = try await inspect(next)
        try Task.checkCancellation()
        guard !closed, epoch == requestedEpoch, file?.id == before.file.id,
              inspected.document.id == before.file.id, file?.revision == before.file.revision else {
            throw recastError("The conversion changed while this operation was running.")
        }
        commit(RecastState(file: inspected.document, assets: before.assets.merging(addedAssets) { old, _ in old }), undo: before, title: title)
        issues = inspected.issues
    }

    private func commit(_ after: RecastState, undo before: RecastState, title: String) {
        owner?.undoManager?.registerUndo(withTarget: self) { target in
            target.cancel()
            target.commit(before, undo: after, title: title)
            target.validateLoaded()
        }
        owner?.undoManager?.setActionName(title)
        install(after)
        rendering = nil
        owner?.updateChangeCount(.changeDone)
    }

    func openExample(_ example: RecastExample) {
        guard let before = state, before.file.sources.isEmpty, before.file.records.isEmpty else {
            error = "Open a new conversion to try an example."
            return
        }
        let url = sourceRoot.appendingPathComponent("src/recast/fixtures/\(example.rawValue).recast")
        perform("Opening invented example") { model in
            let loaded = try RecastPackage.load(url)
            let inspected = try await model.inspect(loaded.file)
            model.commit(RecastState(file: inspected.document, assets: loaded.assets), undo: before, title: "Open invented example")
            model.issues = inspected.issues
            model.loadPreview()
        }
    }

    func chooseSources() {
        guard !busy else { return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.message = "Import screenshots, PDFs, text, or audio up to fifteen minutes. Recast keeps an independent copy."
        panel.begin { [weak self] response in
            if response == .OK { self?.importSources(panel.urls) }
        }
    }

    func importSources(_ urls: [URL]) {
        perform("Importing sources") { model in try await model.ingestSources(urls) }
    }

    func importDropped(_ providers: [NSItemProvider]) {
        perform("Reading dropped sources") { model in
            guard providers.count <= 128 else { throw recastError("Import at most 128 sources at once.") }
            var urls = [URL]()
            for provider in providers {
                try Task.checkCancellation()
                let url: URL? = try await withCheckedThrowingContinuation { continuation in
                    _ = provider.loadObject(ofClass: URL.self) { url, error in
                        if let error { continuation.resume(throwing: error) }
                        else { continuation.resume(returning: url) }
                    }
                }
                if let url { urls.append(url) }
            }
            guard !urls.isEmpty else { throw recastError("The drop did not contain readable file URLs.") }
            try await model.ingestSources(urls)
        }
    }

    private func ingestSources(_ urls: [URL]) async throws {
            for (index, url) in urls.enumerated() {
                try Task.checkCancellation()
                progress = "Importing \(index + 1) of \(urls.count) · \(url.lastPathComponent)"
                let snapshot = try await NativeSourceReader.shared.snapshot(url: url)
                try Task.checkCancellation()
                let source = RecastSource(id: recastID("source"), name: url.lastPathComponent,
                    contentHash: snapshot.contentHash, assetName: snapshot.contentHash + "." + snapshot.fileExtension,
                    mime: snapshot.mime, kind: snapshot.kind, bytes: snapshot.data.count, importedAt: recastTimestamp(),
                    pageCount: snapshot.pages.isEmpty ? nil : snapshot.pages.count, pages: snapshot.pages,
                    textLength: snapshot.textLength, durationMs: snapshot.durationMs, error: snapshot.error)
                try await apply([recastOperation("add-source", ["source": try .encoded(source)])],
                    title: "Import source", addedAssets: [source.assetName: snapshot.data])
                selectedSource = source.id
            }
    }

    func loadPreview() {
        previewTask?.cancel()
        sourceImage = nil; sourceText = ""; sourceTextOffset = 0
        textSelection = NSRange(location: 0, length: 0)
        guard let source, let data = assets[source.assetName] else { audio.clear(); previewBusy = false; return }
        if source.kind == "audio", source.error == nil, let duration = source.durationMs {
            audio.load(data: data, fileExtension: (source.assetName as NSString).pathExtension,
                identity: source.id + source.contentHash, duration: duration / 1000)
            previewBusy = false
            return
        }
        audio.clear()
        let requestedPage = min(max(0, page), pageCount - 1)
        guard ["image", "pdf", "text"].contains(source.kind) else { previewBusy = false; return }
        previewBusy = true
        previewTask = Task { [weak self] in
            guard let self else { return }
            let span = HubPerf.begin("recast.preview", source.kind, awaits: true)
            defer { span.end() }
            do {
                if source.kind == "text" {
                    let slice = try await Task.detached(priority: .userInitiated) {
                        guard let text = String(data: data, encoding: .utf8) else { throw recastError("The source is not valid UTF-8.") }
                        let ns = text as NSString
                        let start = min(ns.length, requestedPage * 32000)
                        let range = ns.rangeOfComposedCharacterSequences(for: NSRange(location: start, length: min(32000, ns.length - start)))
                        return (ns.substring(with: range), range.location)
                    }.value
                    try Task.checkCancellation()
                    sourceText = slice.0; sourceTextOffset = slice.1
                } else {
                    let png = try await RecastPreviewCache.shared.preview(RecastPreviewRequest(data: data,
                        sourceHash: source.contentHash, kind: source.kind, page: requestedPage))
                    try Task.checkCancellation()
                    sourceImage = NSImage(data: png)
                }
                previewBusy = false
                onReady?()
            } catch is CancellationError {
                HubPerf.log("recast: superseded source preview cancelled")
            } catch {
                self.error = error.localizedDescription; previewBusy = false
                onReady?()
            }
        }
    }

    func addRecord() {
        let id = recastID("record"), collectionID = selectedCollection
        perform("Adding record") { model in
            try await model.apply([recastOperation("add-record", ["collectionId": .string(collectionID), "id": .string(id)])], title: "Add record")
            model.selectedRecord = id
        }
    }

    func addCollection(_ collection: RecastCollection) {
        perform("Adding collection") { model in
            try await model.apply([recastOperation("add-collection", ["collection": try .encoded(collection)])], title: "Add collection")
            model.selectedCollection = collection.id; model.normalizeSelection()
        }
    }

    func editCell(text: String, unknown: Bool, note: String) {
        guard let record, let field else { return }
        var cell = record.cells[field.id] ?? RecastCell()
        let value: RecastJSON
        do { value = try Self.manualCellValue(text: text, unknown: unknown, field: field) }
        catch { self.error = error.localizedDescription; return }
        cell.value = value; cell.state = value.isNull ? "unknown" : "proposed"; cell.origin = "user"; cell.note = note
        let correction = cell
        perform("Correcting field") { model in
            try await model.apply([recastOperation("set-cell", [
                "recordId": .string(record.id), "fieldId": .string(field.id), "cell": try .encoded(correction),
                "reason": .string(note.isEmpty ? "User corrected field" : note)
            ])], title: "Correct " + field.label)
        }
    }

    func acceptRecords(all: Bool) {
        let ids = all ? records.map(\.id) : [selectedRecord].filter { !$0.isEmpty }
        guard !ids.isEmpty else { return }
        perform("Accepting reviewed records") { model in
            try await model.apply([recastOperation("accept-records", ["recordIds": .array(ids.map { .string($0) })])], title: "Accept records")
        }
    }

    func archiveRecord() {
        guard !selectedRecord.isEmpty else { return }
        let id = selectedRecord
        perform("Archiving record") { model in
            try await model.apply([recastOperation("archive-records", ["recordIds": .array([.string(id)])])], title: "Archive record")
        }
    }

    func selectField(recordId: String, fieldId: String) {
        selectedRecord = recordId; selectedField = fieldId
        if let id = cell?.anchorIds.first, let anchor = file?.anchors.first(where: { $0.id == id }) {
            reveal(anchor)
        } else {
            selectedAnchor = ""; selectedRegion = nil
        }
    }

    func revealSelectedEvidence(detached: Bool = false) {
        guard let id = cell?.anchorIds.first, let anchor = file?.anchors.first(where: { $0.id == id }) else {
            notice = "This field has no attached source evidence."
            return
        }
        if detached { detachEvidence(anchor) } else { reveal(anchor) }
    }

    func reveal(_ anchor: RecastAnchor) {
        if workspaceMode.effective(width: workspaceWidth) != .split { workspaceMode = .source }
        selectedAnchor = anchor.id
        selectedSource = anchor.sourceId
        page = anchor.region.page ?? ((anchor.region.start ?? 0) / 32000)
        selectedRegion = anchor.region.rectangle
        if anchor.region.kind == "audio", let start = anchor.region.startMs, let end = anchor.region.endMs {
            audio.select(start: start / 1000, end: end / 1000)
        }
        if anchor.region.kind == "text", let start = anchor.region.start, let end = anchor.region.end {
            // The preview completes asynchronously; the text view also resolves selectedAnchor.
            textSelection = NSRange(location: max(0, start - sourceTextOffset), length: end - start)
        }
    }

    var destinationIssues: [RecastIssue] {
        let ids = Set(records.map(\.id))
        return issues.filter { ids.contains($0.recordId) }
    }

    func prepareExport(presentSheet: Bool = true) {
        guard !busy, let file, let collection else { return }
        rendering = nil
        if presentSheet { showExport = true }
        let format = exportFormat
        let includeRecordIDs = exportIncludeRecordIDs
        perform("Preparing export") { model in
            var args = ["--collection", collection.id, "--format", format]
            if !includeRecordIDs { args.append("--no-record-ids") }
            let answer = try await model.command("render", file: file, arguments: args)
            let rendered = try JSONDecoder().decode(RecastRendering.self, from: Data(answer.utf8))
            model.rendering = rendered
        }
    }

    func rememberRendering(_ rendering: RecastRendering) async throws {
        if (file?.renderings ?? []).contains(where: {
            $0.id == rendering.receipt.id || ($0.contentHash == rendering.contentHash &&
                $0.collectionId == rendering.receipt.collectionId && $0.format == rendering.format)
        }) { return }
        try await apply([recastOperation("record-rendering", ["receipt": try .encoded(rendering.receipt)])], title: "Remember export")
        self.rendering = rendering
    }

    func forgetRendering(_ receipt: RecastRenderingReceipt) {
        perform("Forgetting export receipt") { model in
            try await model.apply([recastOperation("forget-rendering", ["receiptId": .string(receipt.id)])], title: "Forget export receipt")
        }
    }

    func copyExport(evidence: Bool) {
        guard let rendering else { return }
        perform("Copying export") { model in
            if !evidence { try await model.rememberRendering(rendering) }
            Clipboard.copy(evidence ? rendering.evidence : rendering.text, what: "Recast export")
        }
    }

    func saveExport(evidence: Bool) {
        guard let rendering else { return }
        let panel = NSSavePanel()
        let ext = evidence ? "evidence.json" : rendering.format == "markdown" ? "md" : rendering.format
        panel.nameFieldStringValue = (file?.title ?? "Conversion") + "." + ext
        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            let content = evidence ? rendering.evidence : rendering.text
            self?.perform("Saving export") { model in
                try await Task.detached(priority: .userInitiated) { try Data(content.utf8).write(to: url, options: .atomic) }.value
                if !evidence {
                    do { try await model.rememberRendering(rendering) }
                    catch { throw recastError("The file was exported, but its re-import receipt could not be saved: " + error.localizedDescription) }
                }
                model.notice = "Exported \(rendering.recordIds.count) records."
            }
        }
    }

    func invalidateProposal() {
        proposal = nil; proposalRequestID = UUID()
        if showAIProposal && busy { cancel() }
    }

    func cancel() {
        task?.cancel(); epoch = UUID(); proposalRequestID = UUID(); busy = false; progress = ""
    }
    func stop() {
        closed = true; cancel(); previewTask?.cancel(); audioReadiness?.cancel(); audio.clear()
        for controller in evidenceWindows { controller.close() }
        evidenceWindows.removeAll()
    }
}

func recastCommandError(_ command: String, result: ToolsRunResult) -> NSError {
    struct Failure: Decodable { var error: String }
    if let message = (try? JSONDecoder().decode(Failure.self, from: Data(result.stdout.utf8)))?.error {
        return recastError(message)
    }
    let diagnostic = result.stderr.isEmpty ? result.stdout : result.stderr
    if result.exitCode >= 128 || diagnostic.contains("Bun has crashed") || diagnostic.contains("panic:") || diagnostic.contains("Segmentation fault") {
        HubPerf.log("recast: \(command) process exit \(result.exitCode): \(diagnostic)")
        let stage = command == "transcribe" ? "Transcription" : command == "propose" ? "AI mapping" : "Recast"
        let next = command == "transcribe"
            ? "Try setting the spoken language, a different model or provider, or a shorter interval."
            : "Reopen this conversion and try again."
        return recastError("\(stage) stopped unexpectedly. Your original sources and saved edits are preserved. \(next)")
    }
    return recastError(String(diagnostic.prefix(4000)))
}
