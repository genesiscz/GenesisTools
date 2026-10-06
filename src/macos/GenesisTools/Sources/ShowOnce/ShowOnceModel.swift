import AppKit
import Foundation
import GenesisKit
import SwiftUI

struct ShowOnceFingerprint: Codable, Equatable { var tag: String; var role: String; var name: String }
struct ShowOnceLocator: Codable, Equatable { var kind: String; var value: String; var name: String?; var fingerprint: ShowOnceFingerprint? }
struct ShowOnceEvidence: Codable, Equatable { var eventId: String; var url: String; var at: Double; var detail: String; var recordedValue: String?; var recordedFilename: String?; var sha256: String?; var recordedLocator: ShowOnceLocator? }
struct ShowOnceStep: Codable, Identifiable, Equatable {
    var id: String; var title: String; var evidence: ShowOnceEvidence; var enabled: Bool; var kind: String
    var locator: ShowOnceLocator?; var pageUrl: String?; var url: String?; var value: String?
    var filename: String?; var destination: String?; var contains: [String]?; var message: String?; var reason: String?
}
struct ShowOnceParameter: Codable, Identifiable, Equatable {
    var name: String; var label: String; var secret: Bool; var defaultValue: String?
    var id: String { name }
}
struct ShowOnceRecipe: Codable, Equatable {
    var version: Int; var id: String; var title: String; var createdAt: String; var allowedOrigins: [String]
    var parameters: [ShowOnceParameter]; var steps: [ShowOnceStep]
}
struct ShowOnceProgress: Codable, Identifiable {
    var runId: String; var stepId: String; var status: String; var message: String; var at: String
    var id: String { runId + stepId + at + status }
}
struct ShowOnceFile: Codable, Identifiable { var path: String; var size: Int; var sha256: String; var id: String { path } }
struct ShowOnceReceipt: Codable { var runId: String; var recipeId: String; var status: String; var events: [ShowOnceProgress]; var files: [ShowOnceFile]; var recipeSha256: String?; var receiptFile: String? }
struct ShowOnceTab: Codable, Identifiable { var id: String; var type: String?; var port: Int?; var title: String; var url: String }
struct ShowOnceBrowser: Decodable, Identifiable { var id: String; var name: String }
struct ShowOnceBrowserLaunch: Decodable { var port: Int }

@MainActor
final class ShowOnceBridge {
    private let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
    private let writeQueue = DispatchQueue(label: "show-once.bridge.write")
    private var partial = Data(), stderr = Data()
    private var pending: [String: CheckedContinuation<Data, Error>] = [:]
    private var deadlines: [String: Task<Void, Never>] = [:]
    var onEvent: (([String: Any]) -> Void)?
    var onExit: ((String) -> Void)?
    init(toolsPath: String) throws {
        let plan = ToolsBridge.launchPlan(binaryPath: toolsPath, argv: ["show-once", "bridge"])
        process.executableURL = plan.executable; process.arguments = plan.arguments
        process.currentDirectoryURL = plan.workingDirectory; process.environment = ToolsBridge.scrubbedEnvironment()
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor in self?.receive(data) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor in
                guard let self else { return }; self.stderr.append(data)
                if self.stderr.count > 8192 { self.stderr = Data(self.stderr.suffix(8192)) }
            }
        }
        process.terminationHandler = { [weak self] process in
            let code = process.terminationStatus
            Task { @MainActor in
                guard let self else { return }
                let message = "Workflow engine ended (\(code)). " + (String(data: self.stderr, encoding: .utf8) ?? "")
                self.fail(message); self.onExit?(message)
            }
        }
        try process.run()
    }
    func request(_ command: [String: Any]) async throws -> Data {
        guard process.isRunning else { throw showOnceError("Workflow engine is unavailable.") }
        let id = UUID().uuidString
        var data = try JSONSerialization.data(withJSONObject: ["id": id, "command": command], options: [.sortedKeys])
        data.append(10)
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            let seconds: UInt64 = command["op"] as? String == "run" ? 310 : command["op"] as? String == "open-browser" ? 45 : 20
            deadlines[id] = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: seconds * 1_000_000_000) }
                catch { return }
                guard let self, let call = self.pending.removeValue(forKey: id) else { return }
                self.deadlines.removeValue(forKey: id)
                call.resume(throwing: showOnceError("Workflow engine exceeded its deadline. Inspect actual state before replaying."))
                self.stop()
            }
            let handle = input.fileHandleForWriting
            writeQueue.async { [weak self] in
                do { try handle.write(contentsOf: data) }
                catch { Task { @MainActor in self?.fail("Could not send workflow request: \(error.localizedDescription)") } }
            }
        }
    }
    private func receive(_ data: Data) {
        guard !data.isEmpty else { return }
        partial.append(data)
        if partial.count > 4_000_000 { fail("Workflow response exceeds its limit."); stop(); return }
        while let newline = partial.firstIndex(of: 10) {
            let line = Data(partial.prefix(upTo: newline)); partial.removeSubrange(...newline)
            do {
                guard let message = try JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                if let event = message["event"] as? [String: Any] { onEvent?(event); continue }
                guard let id = message["id"] as? String, let continuation = pending.removeValue(forKey: id) else { continue }
                deadlines.removeValue(forKey: id)?.cancel()
                if let error = message["error"] as? String { continuation.resume(throwing: showOnceError(error)) }
                else if let result = message["result"] { continuation.resume(returning: try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])) }
                else { continuation.resume(throwing: showOnceError("Workflow response was incomplete.")) }
            } catch { fail("Invalid workflow response: \(error.localizedDescription)") }
        }
    }
    private func fail(_ message: String) {
        let calls = pending.values; pending.removeAll()
        for deadline in deadlines.values { deadline.cancel() }
        deadlines.removeAll()
        for call in calls { call.resume(throwing: showOnceError(message)) }
    }
    func stop() {
        output.fileHandleForReading.readabilityHandler = nil; errors.fileHandleForReading.readabilityHandler = nil
        try? input.fileHandleForWriting.close(); fail("Workflow window closed.")
        if process.isRunning {
            process.terminate()
            let child = process
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            }
        }
    }
}
func showOnceError(_ message: String) -> NSError { NSError(domain: "ShowOnce", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }

@MainActor
final class ShowOnceModel: ObservableObject {
    @Published var recipe: ShowOnceRecipe?
    @Published var selectedStep: String?
    @Published var tabs: [ShowOnceTab] = []
    @Published var browsers: [ShowOnceBrowser] = []
    @Published var browserId = ""
    @Published var browserURL = "https://example.com"
    @Published var targetId = ""
    @Published var port = ""
    @Published var downloads = ""
    @Published var destination = ""
    @Published var title = "Monthly report workflow"
    @Published var recording = false
    @Published var running = false
    @Published var busy = false
    @Published var dirty = false
    @Published var recordingCount = 0
    @Published var capturedDownloads = 0
    @Published var progress: [ShowOnceProgress] = []
    @Published var receipt: ShowOnceReceipt?
    @Published var history: [ShowOnceReceipt] = []
    @Published var notice = "Choose a browser tab, demonstrate the report task, then inspect its recipe."
    @Published var inputs: [String: String] = [:]
    @Published var fileURL: URL?
    @Published var parameterName = "customer"
    @Published var parameterLabel = "Customer"
    @Published var parameterSecret = false
    @Published var showJSON = false
    @Published var jsonDraft = ""
    @Published var checkpoint: ShowOnceProgress?
    private let bridge: ShowOnceBridge
    init(toolsPath: String) throws {
        bridge = try ShowOnceBridge(toolsPath: toolsPath)
        bridge.onEvent = { [weak self] event in self?.receive(event) }
        bridge.onExit = { [weak self] message in self?.notice = message; self?.running = false; self?.recording = false; self?.busy = false }
        task { [self] in
            let data = try await bridge.request(["op": "browsers"])
            browsers = try JSONDecoder().decode([ShowOnceBrowser].self, from: data)
            if browserId.isEmpty { browserId = browsers.first?.id ?? "" }
        }
    }
    var selected: ShowOnceStep? { recipe?.steps.first { $0.id == selectedStep } }
    private func receive(_ event: [String: Any]) {
        if event["type"] as? String == "download" { capturedDownloads += 1; notice = "Download content captured. Rename and move it into the chosen destination, then stop recording." }
        if event["type"] as? String == "recording", let snapshot = event["snapshot"] as? [String: Any], let actions = snapshot["actions"] as? [Any] { recordingCount = actions.count }
        if event["type"] as? String == "progress", let raw = event["event"],
           let data = try? JSONSerialization.data(withJSONObject: raw), let event = try? JSONDecoder().decode(ShowOnceProgress.self, from: data) {
            progress.append(event); selectedStep = event.stepId
            if event.status == "checkpoint" { checkpoint = event }
        }
    }
    func object<T: Encodable>(_ value: T) throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) }
    func task(_ operation: @escaping () async throws -> Void) {
        Task {
            let span = HubPerf.begin("show-once.operation")
            defer { span.end() }
            do { try await operation() } catch { notice = error.localizedDescription; busy = false }
        }
    }
    func refreshTabs() {
        busy = true
        task { [self] in
            defer { busy = false }
            var command: [String: Any] = ["op": "tabs"]
            if !port.trimmingCharacters(in: .whitespaces).isEmpty {
                guard let number = Int(port), (1...65535).contains(number) else { throw showOnceError("Enter a valid debugger port, or clear it to discover tabs.") }
                command["port"] = number
            }
            let data = try await bridge.request(command)
            tabs = try JSONDecoder().decode([ShowOnceTab].self, from: data).filter { $0.type == nil || $0.type == "page" }
            if !tabs.contains(where: { $0.id == targetId }) { targetId = "" }
            notice = tabs.isEmpty ? "No debugger tabs found. Choose an installed browser and Open recording browser to create a separate window." : "Select the exact tab to record or replay."
        }
    }
    func selectTab(_ id: String) {
        if let number = tabs.first(where: { $0.id == id })?.port { port = String(number) }
    }
    func openRecordingBrowser() {
        guard !busy, !running, !recording, !browserId.isEmpty else { return }
        busy = true
        task { [self] in
            defer { busy = false }
            let data = try await bridge.request(["op": "open-browser", "browserId": browserId, "url": browserURL])
            let opened = try JSONDecoder().decode(ShowOnceBrowserLaunch.self, from: data)
            port = String(opened.port)
            let tabData = try await bridge.request(["op": "tabs", "port": opened.port])
            tabs = try JSONDecoder().decode([ShowOnceTab].self, from: tabData)
            targetId = ""
            notice = "Separate recording browser opened. Sign in there if needed, then select its exact tab. The browser stays open when this workflow window closes."
        }
    }
    func chooseFolder(download: Bool) {
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true
        panel.prompt = download ? "Choose downloads" : "Choose destination"
        panel.begin { [weak self] result in
            guard result == .OK, let path = panel.url?.path else { return }
            if download { self?.downloads = path } else { self?.destination = path }
        }
    }
    func startRecording() {
        guard !running, !recording, !busy, confirmDiscard() else { return }
        busy = true
        task { [self] in
            defer { busy = false }
            guard let number = Int(port), !targetId.isEmpty else { throw showOnceError("Choose a connected browser tab first.") }
            _ = try await bridge.request(["op": "record-start", "port": number, "targetId": targetId,
                "downloadDirectory": downloads, "destinationDirectory": destination])
            recording = true; recordingCount = 0; capturedDownloads = 0
            notice = "Recording for at most five minutes. Download the report, wait for 'Download content captured', then rename and move it into the destination."
        }
    }
    func stopRecording() {
        guard recording, !busy else { return }; busy = true
        task { [self] in
            defer { busy = false; recording = false }
            let data = try await bridge.request(["op": "record-stop", "title": title])
            guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], let raw = result["recipe"] else { throw showOnceError("Recording has no recipe.") }
            install(try JSONDecoder().decode(ShowOnceRecipe.self, from: JSONSerialization.data(withJSONObject: raw)))
            fileURL = nil; dirty = true
            notice = "Recorded \(recipe?.steps.count ?? 0) steps. Inspect targets and file checks before replay."
        }
    }
    func install(_ value: ShowOnceRecipe) {
        recipe = value; title = value.title; selectedStep = value.steps.first?.id
        inputs = Dictionary(uniqueKeysWithValues: value.parameters.map { ($0.name, $0.secret ? "" : $0.defaultValue ?? "") })
        progress = []; receipt = nil
        history = []
        task { [self] in
            let data = try await bridge.request(["op": "history", "recipeId": value.id])
            if recipe?.id == value.id { history = try JSONDecoder().decode([ShowOnceReceipt].self, from: data) }
        }
    }
    func mutateStep(_ update: (inout ShowOnceStep) -> Void) {
        guard !running, !recording, var value = recipe, let index = value.steps.firstIndex(where: { $0.id == selectedStep }) else { return }
        update(&value.steps[index]); recipe = value; dirty = true
    }
    func addStep(kind: String) {
        guard !running, !recording, var value = recipe else { return }
        let evidence = ShowOnceEvidence(eventId: "manual-" + UUID().uuidString, url: "", at: Date().timeIntervalSince1970 * 1000, detail: "Explicitly authored in the workflow editor")
        var step = ShowOnceStep(id: UUID().uuidString, title: kind == "checkpoint" ? "Verify this output" : "Rename and move download", evidence: evidence, enabled: true, kind: kind)
        if kind == "checkpoint" { step.message = "Inspect the actual output before continuing." }
        if kind == "move" { step.destination = destination; step.filename = "report.csv"; step.contains = [] }
        value.steps.append(step); recipe = value; selectedStep = step.id; dirty = true
    }
    func deleteStep() {
        guard !running, !recording, var value = recipe, value.steps.count > 1 else { return }
        value.steps.removeAll { $0.id == selectedStep }; recipe = value; selectedStep = value.steps.first?.id; dirty = true
    }
    func moveStep(_ delta: Int) {
        guard !running, !recording, var value = recipe, let index = value.steps.firstIndex(where: { $0.id == selectedStep }) else { return }
        let next = index + delta; guard next >= 0, next < value.steps.count else { return }
        value.steps.swapAt(index, next); recipe = value; dirty = true
    }
    func addParameter() {
        guard var value = recipe, !running, !recording else { return }
        let name = parameterName.trimmingCharacters(in: .whitespaces)
        guard name.range(of: "^[a-z][a-zA-Z0-9_]{0,63}$", options: .regularExpression) != nil,
              !value.parameters.contains(where: { $0.name == name }) else { notice = "Choose a unique parameter name beginning with a lowercase letter."; return }
        let current = selected?.value
        if current?.hasPrefix("{{") == true { notice = "This step already references a parameter. Edit that declaration in the JSON inspector."; return }
        if parameterSecret && selected?.kind != "fill" { notice = "Runtime secrets require an explicit fill step."; return }
        value.parameters.append(ShowOnceParameter(name: name, label: parameterLabel, secret: parameterSecret, defaultValue: parameterSecret ? nil : current))
        if let index = value.steps.firstIndex(where: { $0.id == selectedStep }), value.steps[index].kind == "fill" || value.steps[index].kind == "select" {
            value.steps[index].value = "{{\(name)}}"
            if parameterSecret { value.steps[index].evidence.recordedValue = nil }
        }
        recipe = value; inputs[name] = parameterSecret ? "" : current ?? ""; dirty = true
        notice = "Parameter added. Use {{\(name)}} in changing values, filenames, and content checks."
    }
    func validate() {
        guard let value = recipe else { return }
        task { [self] in _ = try await bridge.request(["op": "validate", "recipe": try object(value)]); notice = "Recipe schema, references, and secret rules passed." }
    }
    func run() {
        guard !running, !recording, !busy, let value = recipe else { return }
        running = true; progress = []; receipt = nil; checkpoint = nil
        task { [self] in
            defer { running = false; checkpoint = nil }
            guard let number = Int(port), !targetId.isEmpty else { throw showOnceError("Select a connected browser tab.") }
            let data = try await bridge.request(["op": "run", "recipe": try object(value), "inputs": inputs, "port": number, "targetId": targetId])
            receipt = try JSONDecoder().decode(ShowOnceReceipt.self, from: data)
            if let receipt { history.insert(receipt, at: 0) }
            notice = receipt?.status == "completed" ? (receipt?.files.isEmpty == false ? "Replay completed. Checked file paths are below; content-rule outcomes are in the progress receipt." : "Actions completed. This recipe did not verify a file output.") : "Replay stopped. Inspect the failure, repair the recipe, then start a new run explicitly."
        }
    }
    func cancel() { task { [self] in _ = try await bridge.request(["op": "cancel"]); recording = false; notice = "Cancellation requested. Dispatched actions are not undone or repeated." } }
    func resume() {
        guard let event = checkpoint else { return }
        task { [self] in _ = try await bridge.request(["op": "resume", "runId": event.runId, "stepId": event.stepId]); checkpoint = nil }
    }
    func save(export: Bool = false) {
        guard let value = recipe, !recording, !running else { return }
        if !export, let fileURL { write(value, to: fileURL, export: false); return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = title + ".showonce.json"; panel.title = export ? "Export portable recipe" : "Save workflow"
        panel.begin { [weak self] result in guard result == .OK, let url = panel.url else { return }; self?.write(value, to: url, export: export) }
    }
    private func write(_ value: ShowOnceRecipe, to url: URL, export: Bool) {
        task { [self] in
            _ = try await bridge.request(["op": "save", "recipe": try object(value), "file": url.path])
            if !export { fileURL = url; if recipe == value { dirty = false } }
            notice = export ? "Portable recipe exported. Runtime secret values were not included." : "Workflow saved."
        }
    }
    func chooseOpen() {
        guard !running, !recording, confirmDiscard() else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.begin { [weak self] result in guard result == .OK, let url = panel.url else { return }; self?.open(url) }
    }
    func open(_ url: URL) {
        guard !busy, !running, !recording else { return }
        busy = true
        task { [self] in
            defer { busy = false }
            let data = try await bridge.request(["op": "open", "file": url.path])
            install(try JSONDecoder().decode(ShowOnceRecipe.self, from: data)); fileURL = url; dirty = false
            notice = "Workflow reopened and validated. Enter runtime inputs and choose the tab before replay."
        }
    }
    func confirmDiscard() -> Bool {
        guard dirty else { return true }
        let alert = NSAlert(); alert.messageText = "Discard unsaved workflow edits?"; alert.addButton(withTitle: "Keep editing"); alert.addButton(withTitle: "Discard")
        return alert.runModal() == .alertSecondButtonReturn
    }
    func editJSON() {
        guard let value = recipe else { return }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        jsonDraft = (try? String(data: encoder.encode(value), encoding: .utf8)) ?? ""; showJSON = true
    }
    func applyJSON() {
        task { [self] in
            guard let data = jsonDraft.data(using: .utf8) else { return }
            let raw = try JSONSerialization.jsonObject(with: data)
            let result = try await bridge.request(["op": "validate", "recipe": raw])
            install(try JSONDecoder().decode(ShowOnceRecipe.self, from: result)); dirty = true; showJSON = false
            notice = "Explicit recipe edits validated. Start a new run to test repaired targets."
        }
    }
    func stop() { bridge.stop() }
}
