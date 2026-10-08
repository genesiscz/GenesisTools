import AppKit
import Combine
import GenesisKit
import UniformTypeIdentifiers

@MainActor
final class ModelRoomModel: ObservableObject {
    @Published var file: ModelRoomFile?
    @Published var evaluation: ModelRoomEvaluation?
    @Published var selectedQuantity = "backlog"
    @Published var selectedScenario = "" {
        didSet { if selectedScenario != oldValue { normalizeSelection() } }
    }
    @Published var mode = ModelRoomMode.build
    @Published var tick = 0
    @Published var busy = false
    @Published var error: String?
    @Published var stale = false
    @Published var playing = false
    @Published var presentationStep = 0
    @Published var showAddQuantity = false
    @Published var showSweep = false
    @Published var showEditor = false
    @Published var showAIProposal = false
    var proposalTask: Task<Void, Never>?
    var openReviewedModel: ((ModelRoomFile) throws -> Void)?
    @Published var showSubsystemExport = false
    @Published var subsystemImport: ModelRoomSubsystemSource?
    var subsystemTask: Task<Void, Never>?
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
    private var importID = UUID()
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
        return frames[max(0, min(tick, frames.count - 1))]
    }

    var effectiveQuantities: [ModelRoomQuantity] { file?.effectiveQuantities(scenarioID: selectedScenario) ?? [] }
    var selected: ModelRoomQuantity? { effectiveQuantities.first { $0.id == selectedQuantity } }
    var relationships: [ModelRoomRelationship] { scenarioResult?.relationships ?? [] }

    func normalizeSelection() {
        guard let file else { return }
        if !selectedScenario.isEmpty && !file.scenarios.contains(where: { $0.id == selectedScenario }) { selectedScenario = "" }
        let ids = Set(effectiveQuantities.map(\.id))
        if !ids.contains(selectedQuantity) {
            selectedQuantity = file.presentation.outputs.first(where: { ids.contains($0) }) ?? effectiveQuantities.first?.id ?? ""
        }
        tick = min(max(0, tick), maximumTick)
        presentationStep = min(max(0, presentationStep), max(0, file.presentation.steps.count - 1))
    }
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
                selectedScenario = ""
                normalizeSelection()
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

    func commitDraft(_ draft: ModelRoomFile, replacing original: ModelRoomFile, actionName: String = "Edit model and presentation") throws {
        guard file == original else { throw modelError("The model changed while this editor was open. Reopen the editor to work from the latest revision.") }
        try draft.validateForEditing()
        guard draft != original else { return }
        apply(draft, undo: original, title: actionName)
    }

    func validateDraft(_ draft: ModelRoomFile) async throws -> ModelRoomFile {
        try draft.validateForEditing()
        let answer = try await documentCommand(draft, command: "evaluate")
        let result = try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(ModelRoomEvaluation.self, from: Data(answer.utf8))
        }.value
        try Task.checkCancellation()
        if let invalid = result.scenarios.first(where: { $0.error != nil }) {
            throw modelError("\(invalid.label): \(invalid.error ?? "Invalid scenario")")
        }
        return result.document
    }

    func convertDraftTime(_ draft: ModelRoomFile, unit: String) async throws -> ModelRoomFile {
        let answer = try await documentCommand(draft, command: "convert-time", arguments: ["--unit", unit])
        let converted = try JSONDecoder().decode(ModelRoomFile.self, from: Data(answer.utf8))
        try converted.validateForEditing()
        return converted
    }

    func documentCommand(_ draft: ModelRoomFile, command: String, arguments: [String] = [], attachments: [ModelRoomCommandAttachment] = []) async throws -> String {
        try await modelCommand(document: draft, command: command, arguments: arguments, attachments: attachments)
    }

    func modelCommand(document draft: ModelRoomFile? = nil, command: String, arguments: [String] = [], attachments: [ModelRoomCommandAttachment] = [], timeoutSeconds: Int = 30) async throws -> String {
        let span = HubPerf.begin("model-room.author", command)
        defer { span.end() }
        let prepared = try await Task.detached(priority: .userInitiated) {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("model-room-draft-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            do {
                var args: [String] = []
                if let draft {
                    let input = folder.appendingPathComponent("model.json")
                    try JSONEncoder().encode(draft).write(to: input, options: .atomic)
                    args = ["--input", input.path]
                }
                for (index, attachment) in attachments.enumerated() {
                    let file = folder.appendingPathComponent("attachment-\(index).json")
                    try attachment.data.write(to: file, options: .atomic)
                    args += [attachment.flag, file.path]
                }
                return (folder, args)
            } catch {
                do { try FileManager.default.removeItem(at: folder) }
                catch { HubPerf.log("model-room: failed draft preparation cleanup: \(error)") }
                throw error
            }
        }.value
        defer {
            do { try FileManager.default.removeItem(at: prepared.0) }
            catch { HubPerf.log("model-room: draft temporary cleanup: \(error)") }
        }
        try Task.checkCancellation()
        let answer = try await bridge.run(subcommand: "model-room", args: [command] + prepared.1 + arguments, timeoutSeconds: timeoutSeconds)
        try Task.checkCancellation()
        guard answer.exitCode == 0 else { throw modelRoomCommandFailure(answer) }
        return answer.stdout
    }

    private func apply(_ after: ModelRoomFile, undo before: ModelRoomFile, title: String) {
        owner?.undoManager?.registerUndo(withTarget: self) { target in
            target.apply(before, undo: after, title: title)
        }
        owner?.undoManager?.setActionName(title)
        file = after
        normalizeSelection()
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
            self.file = file
            selectedScenario = id
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
        evaluate()
    }

    func inputValue(_ quantity: ModelRoomQuantity) -> Double {
        file?.scenarios.first { $0.id == selectedScenario }?.overrides[quantity.id] ?? quantity.baseValue
    }

    func updateQuantity(_ id: String, title: String, edit: (inout ModelRoomQuantity) -> Void) {
        let scenarioID = selectedScenario
        change(title) { $0.editQuantity(id: id, scenarioID: scenarioID, edit: edit) }
    }

    func moveQuantity(_ id: String, to position: ModelRoomPoint) {
        guard var file else { return }
        file.editQuantity(id: id, scenarioID: selectedScenario) { $0.position = position }
        self.file = file
    }

    func removeSelected() {
        let id = selectedQuantity
        let scenarioID = selectedScenario
        change("Delete quantity") { file in
            if let index = file.scenarios.firstIndex(where: { $0.id == scenarioID }) {
                file.scenarios[index].replacements.removeAll { $0.id == id }
                if file.quantities.contains(where: { $0.id == id }) { file.scenarios[index].removed.append(id) }
                file.scenarios[index].overrides.removeValue(forKey: id)
                for intervention in file.scenarios[index].interventions.indices { file.scenarios[index].interventions[intervention].values.removeValue(forKey: id) }
            } else {
                file.quantities.removeAll { $0.id == id }
                file.presentation.controls.removeAll { $0 == id }
                file.presentation.outputs.removeAll { $0 == id }
                for index in file.subsystems.indices { file.subsystems[index].quantities.removeAll { $0 == id } }
                file.subsystems.removeAll { $0.quantities.isEmpty }
                for index in file.scenarios.indices {
                    file.scenarios[index].removed.removeAll { $0 == id }
                    if !file.scenarios[index].replacements.contains(where: { $0.id == id }) {
                        file.scenarios[index].overrides.removeValue(forKey: id)
                        for intervention in file.scenarios[index].interventions.indices { file.scenarios[index].interventions[intervention].values.removeValue(forKey: id) }
                    }
                }
            }
        }
        normalizeSelection()
    }

    func addQuantity(label: String, kind: String, unit: String) {
        let existing = Set((file?.quantities.map(\.id) ?? []) + (file?.scenarios.flatMap { $0.replacements.map(\.id) } ?? []))
        let id = ModelRoomLimits.identifier(label: label, prefix: "q_", existing: existing)
        let scenarioID = selectedScenario
        change("Add quantity") { file in
            let quantity = ModelRoomQuantity(id: id, label: label, unit: unit, position: ModelRoomLimits.position(for: file.effectiveQuantities(scenarioID: scenarioID).count), kind: kind, value: kind == "input" ? 1 : nil, expression: kind == "formula" ? "1[\(unit)]" : nil, initial: kind == "stock" ? 0 : nil, derivative: kind == "stock" ? "0[\(unit)/\(file.time.unit)]" : nil)
            if let index = file.scenarios.firstIndex(where: { $0.id == scenarioID }) { file.scenarios[index].replacements.append(quantity) }
            else { file.quantities.append(quantity) }
        }
        if effectiveQuantities.contains(where: { $0.id == id }) { selectedQuantity = id }
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
    func stop() { calculation?.cancel(); exportTask?.cancel(); cancelObservationImport(); subsystemTask?.cancel(); proposalTask?.cancel(); revision += 1; busy = false; exporting = false; stopPlayback() }

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

    func cancelObservationImport() {
        importTask?.cancel()
        importTask = nil
        importID = UUID()
        importing = false
    }

    func previewTable(url: URL, delimiter: String) {
        cancelObservationImport()
        let requestID = UUID()
        importID = requestID
        importing = true
        importTask = Task { [weak self] in
            guard let self else { return }
            let span = HubPerf.begin("model-room.table.preview", url.lastPathComponent)
            defer { span.end(); if importID == requestID { importing = false } }
            do {
                try Task.checkCancellation()
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
        let requestID = UUID()
        importID = requestID
        importing = true
        importTask = Task { [weak self] in
            guard let self else { return }
            let span = HubPerf.begin("model-room.table.import", source.url.lastPathComponent)
            defer { span.end(); if importID == requestID { importing = false } }
            do {
                try Task.checkCancellation()
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
