import AppKit
import Combine
import GenesisKit
import UniformTypeIdentifiers

@MainActor
final class ModelRoomModel: ObservableObject {
    @Published var file: ModelRoomFile?
    @Published var evaluation: ModelRoomEvaluation?
    @Published var selectedQuantity = "backlog"
    @Published var selectedScenario = ""
    @Published var mode = ModelRoomMode.build
    @Published var tick = 0
    @Published var busy = false
    @Published var error: String?
    @Published var stale = false
    @Published var playing = false
    @Published var presentationStep = 0
    @Published var showAddQuantity = false
    @Published var showSweep = false
    @Published var exporting = false
    @Published var notice: String?
    @Published var tableImport: ModelRoomTableSource?
    @Published var importing = false
    weak var owner: ModelRoomDocument?
    var onEvaluated: (() -> Void)?
    let bridge: ToolsBridge
    private var calculation: Task<Void, Never>?
    private var playback: Task<Void, Never>?
    private var exportTask: Task<Void, Never>?
    private var importTask: Task<Void, Never>?
    private var revision = 0
    private var gestureBefore: ModelRoomFile?
    private var gestureScenarioBefore = ""

    init(toolsPath: String) {
        bridge = ToolsBridge(binaryPath: toolsPath)
    }

    var scenarioResult: ModelRoomEvaluatedScenario? {
        evaluation?.scenarios.first { $0.selectionID == selectedScenario }
    }

    var frame: ModelRoomFrame? {
        guard let frames = scenarioResult?.result?.frames, !frames.isEmpty else { return nil }
        return frames[min(tick, frames.count - 1)]
    }

    var selected: ModelRoomQuantity? { file?.quantities.first { $0.id == selectedQuantity } }
    var maximumTick: Int {
        let count = (file?.time.duration ?? 10) / (file?.time.step ?? 1)
        guard count.isFinite, count >= 1, count <= 10000 else { return 1 }
        return Int(count.rounded())
    }

    func loadExample(_ name: String) {
        calculation?.cancel()
        busy = true
        calculation = Task { [weak self] in
            guard let self else { return }
            let span = HubPerf.begin("model-room.example", name)
            defer { span.end() }
            do {
                let answer = try await bridge.run(subcommand: "model-room", args: ["example", name], timeoutSeconds: 20)
                try Task.checkCancellation()
                guard answer.exitCode == 0 else { throw modelRoomCommandFailure(answer) }
                let loaded = try JSONDecoder().decode(ModelRoomFile.self, from: Data(answer.stdout.utf8))
                try loaded.validateForEditing()
                file = loaded
                selectedQuantity = loaded.presentation.outputs.first ?? loaded.quantities.first?.id ?? ""
                owner?.displayName = loaded.title
                busy = false
                evaluate(immediate: true)
            } catch is CancellationError {
                HubPerf.log("model-room: example load cancelled")
            } catch {
                self.error = error.localizedDescription
                busy = false
            }
        }
    }

    func evaluate(immediate: Bool = false) {
        calculation?.cancel()
        revision += 1
        let requestedRevision = revision
        guard let file else { return }
        busy = true
        stale = evaluation != nil
        calculation = Task { [weak self] in
            guard let self else { return }
            do {
                if !immediate { try await Task.sleep(for: .milliseconds(160)) }
                try Task.checkCancellation()
                let span = HubPerf.begin("model-room.evaluate", "\(file.quantities.count) quantities")
                defer { span.end() }
                let input = try await Task.detached(priority: .userInitiated) {
                    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("genesis-model-room", isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    let url = folder.appendingPathComponent(UUID().uuidString + ".json")
                    try JSONEncoder().encode(file).write(to: url, options: .atomic)
                    return url
                }.value
                defer {
                    do { try FileManager.default.removeItem(at: input) }
                    catch { HubPerf.log("model-room: temporary input cleanup: \(error)") }
                }
                try Task.checkCancellation()
                let answer = try await bridge.run(subcommand: "model-room", args: ["evaluate", "--input", input.path], timeoutSeconds: 25)
                try Task.checkCancellation()
                guard requestedRevision == revision else { return }
                guard answer.exitCode == 0 else { throw modelRoomCommandFailure(answer) }
                let data = Data(answer.stdout.utf8)
                let next = try await Task.detached(priority: .userInitiated) {
                    var decoded = try JSONDecoder().decode(ModelRoomEvaluation.self, from: data)
                    decoded.prepareCharts()
                    return decoded
                }.value
                try Task.checkCancellation()
                guard requestedRevision == revision else { return }
                evaluation = next
                stale = false
                error = nil
                busy = false
                tick = min(tick, maximumTick)
                onEvaluated?()
            } catch is CancellationError {
                HubPerf.log("model-room: superseded calculation cancelled")
            } catch {
                guard requestedRevision == revision else { return }
                self.error = error.localizedDescription
                busy = false
                stale = evaluation != nil
            }
        }
    }

    func change(_ title: String, edit: (inout ModelRoomFile) -> Void) {
        guard let before = file else { return }
        var after = before
        edit(&after)
        guard before != after else { return }
        do { try after.validateForEditing() }
        catch { self.error = error.localizedDescription; return }
        apply(after, undo: before, title: title)
    }

    private func apply(_ after: ModelRoomFile, undo before: ModelRoomFile, title: String) {
        owner?.undoManager?.registerUndo(withTarget: self) { target in
            target.apply(before, undo: after, title: title)
        }
        owner?.undoManager?.setActionName(title)
        file = after

        owner?.displayName = after.title
        evaluate()
    }

    func beginGesture(branch: Bool = false) {
        guard gestureBefore == nil, var file else { return }
        gestureBefore = file
        gestureScenarioBefore = selectedScenario
        if branch {
            let id = "branch_" + UUID().uuidString.replacingOccurrences(of: "-", with: "_")
            let prior = file.scenarios.first { $0.id == selectedScenario }
            file.scenarios.append(ModelRoomScenario(id: id, label: "Scenario \(file.scenarios.count + 1)", overrides: prior?.overrides ?? [:], interventions: prior?.interventions ?? [], replacements: prior?.replacements ?? [], removed: prior?.removed ?? []))
            selectedScenario = id
            self.file = file
        }
    }

    func setInput(_ id: String, value: Double) {
        guard value.isFinite, var file else { return }
        let discreteEdit = gestureBefore == nil
        if discreteEdit { beginGesture() }
        if let index = file.scenarios.firstIndex(where: { $0.id == selectedScenario }) {
            file.scenarios[index].overrides[id] = value
        } else if let index = file.quantities.firstIndex(where: { $0.id == id }) {
            file.quantities[index].value = value
        }
        self.file = file
        evaluate()
        if discreteEdit { finishGesture() }
    }

    func finishGesture() {
        guard let before = gestureBefore, let after = file else { return }
        let beforeScenario = gestureScenarioBefore
        let afterScenario = selectedScenario
        gestureBefore = nil
        guard before != after else { return }
        do { try after.validateForEditing() }
        catch {
            file = before
            selectedScenario = beforeScenario
            evaluate(immediate: true)
            self.error = error.localizedDescription
            return
        }
        registerGestureUndo(before: before, beforeScenario: beforeScenario, after: after, afterScenario: afterScenario)
    }

    private func registerGestureUndo(before: ModelRoomFile, beforeScenario: String, after: ModelRoomFile, afterScenario: String) {
        owner?.undoManager?.registerUndo(withTarget: self) { target in
            target.registerGestureUndo(before: after, beforeScenario: afterScenario, after: before, afterScenario: beforeScenario)
            target.file = before
            target.selectedScenario = beforeScenario
            target.evaluate(immediate: true)
        }
        owner?.undoManager?.setActionName("Change assumption")
    }

    func forkScenario() {
        beginGesture(branch: true)
        finishGesture()
    }

    func inputValue(_ quantity: ModelRoomQuantity) -> Double {
        file?.scenarios.first { $0.id == selectedScenario }?.overrides[quantity.id] ?? quantity.baseValue
    }

    func updateQuantity(_ id: String, title: String, edit: (inout ModelRoomQuantity) -> Void) {
        change(title) { file in
            guard let index = file.quantities.firstIndex(where: { $0.id == id }) else { return }
            edit(&file.quantities[index])
        }
    }

    func removeSelected() {
        let id = selectedQuantity
        change("Delete quantity") { file in
            file.quantities.removeAll { $0.id == id }
            file.presentation.controls.removeAll { $0 == id }
            file.presentation.outputs.removeAll { $0 == id }
        }
        selectedQuantity = file?.quantities.first?.id ?? ""
    }

    func addQuantity(label: String, kind: String, unit: String) {
        let id = "q_" + UUID().uuidString.replacingOccurrences(of: "-", with: "_")
        change("Add quantity") { file in
            file.quantities.append(ModelRoomQuantity(id: id, label: label, unit: unit, position: ModelRoomLimits.position(for: file.quantities.count), kind: kind, value: kind == "input" ? 1 : nil, expression: kind == "formula" ? "1" : nil, initial: kind == "stock" ? 0 : nil, derivative: kind == "stock" ? "0[\(unit)/\(file.time.unit)]" : nil))
        }
        selectedQuantity = id
    }

    func togglePlayback() {
        if playing { stopPlayback(); return }
        if tick >= maximumTick { tick = 0 }
        playing = true
        playback = Task { [weak self] in
            guard let self else { return }
            do {
                while tick < maximumTick {
                    try await Task.sleep(for: .milliseconds(450))
                    try Task.checkCancellation()
                    tick += 1
                }
            } catch {
                HubPerf.log("model-room: playback stopped: \(error)")
            }
            playing = false
        }
    }

    func stopPlayback() { playback?.cancel(); playback = nil; playing = false }
    func stop() { calculation?.cancel(); exportTask?.cancel(); importTask?.cancel(); revision += 1; busy = false; exporting = false; importing = false; stopPlayback() }

    func chooseObservationTable() {
        guard let window = owner?.windowControllers.first?.window, !importing else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.commaSeparatedText, .tabSeparatedText, .plainText]
        panel.directoryURL = owner?.fileURL?.deletingLastPathComponent() ?? ModelRoomConfiguration.initialDirectory
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.previewTable(url: url, delimiter: url.pathExtension == "tsv" ? "tab" : "comma")
        }
    }

    func previewTable(url: URL, delimiter: String) {
        importTask?.cancel()
        importing = true
        importTask = Task { [weak self] in
            guard let self else { return }
            let span = HubPerf.begin("model-room.table.preview", url.lastPathComponent)
            defer { span.end(); importing = false }
            do {
                let answer = try await bridge.run(subcommand: "model-room", args: ["inspect-table", "--data", url.path, "--delimiter", delimiter], timeoutSeconds: 15)
                try Task.checkCancellation()
                guard answer.exitCode == 0 else { throw modelRoomCommandFailure(answer) }
                let preview = try JSONDecoder().decode(ModelRoomTablePreview.self, from: Data(answer.stdout.utf8))
                tableImport = ModelRoomTableSource(url: url, delimiter: delimiter, table: preview)
            } catch is CancellationError {
                HubPerf.log("model-room: table preview cancelled")
            } catch { self.error = error.localizedDescription }
        }
    }

    func importObservations(source: ModelRoomTableSource, timeColumn: String, valueColumn: String, label: String, unit: String, interpolation: String, decimal: String) {
        guard let file, !importing else { return }
        let revisionAtStart = revision
        let id = "data_" + UUID().uuidString.replacingOccurrences(of: "-", with: "_")
        importing = true
        importTask = Task { [weak self] in
            guard let self else { return }
            let span = HubPerf.begin("model-room.table.import", source.url.lastPathComponent)
            defer { span.end(); importing = false }
            do {
                let input = try await Task.detached(priority: .userInitiated) {
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent("model-room-import-" + UUID().uuidString + ".json")
                    try JSONEncoder().encode(file).write(to: url, options: .atomic)
                    return url
                }.value
                defer {
                    do { try FileManager.default.removeItem(at: input) }
                    catch { HubPerf.log("model-room: import temporary cleanup: \(error)") }
                }
                let answer = try await bridge.run(subcommand: "model-room", args: ["import-data", "--input", input.path, "--data", source.url.path, "--expected-sha256", source.table.sha256, "--id", id, "--label", label, "--unit", unit, "--time-column", timeColumn, "--value-column", valueColumn, "--delimiter", source.delimiter, "--interpolation", interpolation, "--decimal", decimal], timeoutSeconds: 20)
                try Task.checkCancellation()
                guard answer.exitCode == 0 else { throw modelRoomCommandFailure(answer) }
                let imported = try JSONDecoder().decode(ModelRoomFile.self, from: Data(answer.stdout.utf8))
                guard revisionAtStart == revision else { throw modelError("The model changed during import. Review the mapping and try again.") }
                change("Import observations") { $0 = imported }
                selectedQuantity = id
                tableImport = nil
                notice = "Imported \(source.table.rowCount) observations"
            } catch is CancellationError {
                HubPerf.log("model-room: observation import cancelled")
            } catch { self.error = error.localizedDescription }
        }
    }

    func exportDocument(format: String) {
        guard let file, !exporting, let window = owner?.windowControllers.first?.window else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = format == "html" ? [.html] : [.commaSeparatedText]
        panel.directoryURL = owner?.fileURL?.deletingLastPathComponent() ?? ModelRoomConfiguration.initialDirectory
        panel.nameFieldStringValue = file.title + (format == "html" ? ".html" : "-\(format).csv")
        panel.message = format == "html" ? "A standalone interactive model that works offline." : "An editable table from this model revision."
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let destination = panel.url, let self else { return }
            exporting = true
            exportTask = Task { [weak self] in
                guard let self else { return }
                let span = HubPerf.begin("model-room.export", format)
                defer { span.end(); exporting = false }
                do {
                    let folder = try await Task.detached(priority: .userInitiated) {
                        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("genesis-model-room-export-" + UUID().uuidString, isDirectory: true)
                        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                        try JSONEncoder().encode(file).write(to: folder.appendingPathComponent("model.json"), options: .atomic)
                        return folder
                    }.value
                    defer {
                        do { try FileManager.default.removeItem(at: folder) }
                        catch { HubPerf.log("model-room: export temporary cleanup: \(error)") }
                    }
                    try Task.checkCancellation()
                    let output = folder.appendingPathComponent("output")
                    let answer = try await bridge.run(subcommand: "model-room", args: ["export", "--input", folder.appendingPathComponent("model.json").path, "--output", output.path, "--format", format], timeoutSeconds: 35)
                    try Task.checkCancellation()
                    guard answer.exitCode == 0 else { throw modelRoomCommandFailure(answer) }
                    try await Task.detached(priority: .userInitiated) {
                        let data = try Data(contentsOf: output)
                        try data.write(to: destination, options: .atomic)
                    }.value
                    notice = "Exported \(destination.lastPathComponent)"
                } catch is CancellationError {
                    notice = "Export cancelled"
                } catch {
                    self.error = error.localizedDescription
                }
            }
        }
    }

    private func modelError(_ message: String) -> NSError {
        NSError(domain: "ModelRoom", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

func modelRoomCommandFailure(_ answer: ToolsRunResult) -> NSError {
    let structured = (try? JSONDecoder().decode([String: String].self, from: Data(answer.stdout.utf8)))?["error"]
    let candidates = [structured ?? "", answer.stderr, answer.stdout].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    let message = candidates.first { !$0.isEmpty } ?? "The local tool failed with exit code \(answer.exitCode)."
    let readable = message.hasPrefix("ERROR: ") ? String(message.dropFirst(7)) : message
    return NSError(domain: "ModelRoom", code: Int(answer.exitCode), userInfo: [NSLocalizedDescriptionKey: readable])
}
