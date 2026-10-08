import AppKit
import GenesisKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class BugToTestModel: ObservableObject {
    @Published var tabs: [BugToTestTab] = []
    @Published var browsers: [BugToTestBrowser] = []
    @Published var selectedBrowser = ""
    @Published var initialBrowserURL = ""
    private(set) var openedBrowser: BugToTestOpenedBrowser?
    @Published var selectedTab = ""
    @Published var port = ""
    @Published var title = "Browser bug"
    @Published var recording: BugToTestRecording?
    @Published var result: BugToTestResult?
    @Published var source = ""
    @Published var busy = false
    @Published var isRecording = false
    @Published var progress = ""
    @Published var error: String?
    @Published var notice: String?
    @Published var description = ""
    @Published var assertionKind = "text"
    @Published var locatorKind = "testId"
    @Published var locatorValue = ""
    @Published var locatorName = ""
    @Published var expected = ""
    @Published var baseURL = ""
    @Published var browserBinary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    @Published var reviewPage = "actions"
    @Published var exportFixtures: [URL] = []
    var onReady: (() -> Void)?
    private let bridge: ToolsBridge
    private var task: Task<Void, Never>?
    private var recordingURL: URL
    private var stopURL: URL
    private var saveTask: Task<Void, Never>?
    private var traceStream: ToolsLineStream?
    private(set) var epoch = UUID()

    init(toolsPath: String, storageDirectory: URL? = nil) {
        bridge = ToolsBridge(binaryPath: toolsPath, server: nil)
        let folder = (storageDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0])
            .appendingPathComponent("GenesisTools/BugToTest/" + UUID().uuidString)
        recordingURL = folder.appendingPathComponent("recording.json")
        stopURL = folder.appendingPathComponent("stop")
    }
    var expectation: BugToTestExpectation {
        BugToTestExpectation(description: description, kind: assertionKind,
            locator: assertionKind == "url" ? nil : BugToTestLocator(kind: locatorKind, value: locatorValue, name: locatorKind == "role" ? locatorName : nil), expected: expected)
    }
    var canGenerate: Bool {
        guard var file = recording, !busy else { return false }
        file.title = title; file.expectation = expectation
        return file.validForGeneration
    }
    var workspace: String? { recording?.workspace }
    var localRecordingPath: String { recordingURL.path }

    func perform(_ message: String, work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        let identity = UUID(); epoch = identity; busy = true; progress = message; error = nil
        task = Task {
            let span = HubPerf.begin("bug-to-test.operation", message, awaits: true)
            defer { span.end() }
            do {
                try await work()
                try Task.checkCancellation()
            } catch is CancellationError {
                if epoch == identity { notice = "Cancelled. Saved recording and prior results are preserved." }
            } catch {
                HubPerf.log("bug-to-test: \(message) failed: \(error)")
                if epoch == identity { self.error = error.localizedDescription }
            }
            if epoch == identity { busy = false; isRecording = false; progress = ""; onReady?() }
        }
    }
    func command<T: Decodable>(_ command: String, args: [String], timeout: Int = 45, as type: T.Type) async throws -> T {
        let answer = try await bridge.run(subcommand: "bug-to-test", args: [command] + args, timeoutSeconds: timeout, cancellationGraceSeconds: 4)
        try Task.checkCancellation()
        guard answer.exitCode == 0 else { throw bugToTestError(String(answer.stderr.suffix(4000))) }
        return try JSONDecoder().decode(T.self, from: Data(answer.stdout.utf8))
    }
    func refreshTabs() {
        perform("Finding local browser tabs") {
            self.browsers = try await self.command("browsers", args: [], as: [BugToTestBrowser].self)
            if !self.browsers.contains(where: { $0.id == self.selectedBrowser }) { self.selectedBrowser = self.browsers.first?.id ?? "" }
            self.tabs = try await self.command("tabs", args: self.port.isEmpty ? [] : ["--port", self.port], as: [BugToTestTab].self)
            if self.tabs.count == 1 { self.selectedTab = self.tabs[0].id }
            if self.tabs.isEmpty { self.notice = "No debuggable HTTP tabs found. Enable a local browser debugging endpoint, then refresh. The browser will not be restarted." }
        }
    }
    func openRecordingBrowser() {
        guard !selectedBrowser.isEmpty else { return }
        perform("Opening a separate recording browser") {
            var args = ["--browser", self.selectedBrowser]
            if !self.initialBrowserURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { args += ["--url", self.initialBrowserURL] }
            let browser = try await self.command("open-browser", args: args, timeout: 40, as: BugToTestOpenedBrowser.self)
            self.openedBrowser = browser; self.port = String(browser.port)
            self.tabs = try await self.command("tabs", args: ["--port", self.port], as: [BugToTestTab].self)
            if self.tabs.count == 1 { self.selectedTab = self.tabs[0].id } else { self.selectedTab = "" }
            self.notice = "Separate recording browser opened. Navigate to your task, refresh tabs and choose the exact tab. Sign in there if your task needs it."
        }
    }
    func startRecording() {
        guard let tab = tabs.first(where: { $0.id == selectedTab }), !busy else { return }
        let folder = recordingURL.deletingLastPathComponent()
        stopURL = folder.appendingPathComponent("stop-" + UUID().uuidString)
        perform("Recording selected tab. Reproduce the bug, then Stop recording.") {
            self.isRecording = true
            try await Task.detached { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }.value
            let file = try await self.command("record", args: ["--port", String(tab.port), "--tab", tab.id, "--output", self.recordingURL.path,
                "--stop", self.stopURL.path, "--title", self.title, "--seconds", "300"], timeout: 315, as: BugToTestRecording.self)
            self.install(file)
            self.notice = "Recording saved locally. Review actions and browser evidence before generating."
        }
    }
    func stopRecording() {
        guard isRecording else { return }
        progress = "Stopping recording and saving browser evidence"
        let url = stopURL
        Task {
            do { try await Task.detached { try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true); try Data().write(to: url, options: .atomic) }.value }
            catch { self.error = error.localizedDescription }
        }
    }
    func cancel() {
        if isRecording { stopRecording(); return }
        task?.cancel()
    }
    func openTrace() {
        guard let workspace, result?.trace != nil else { return }
        traceStream?.stop()
        do {
            traceStream = try ToolsLineStream(bridge: bridge, subcommand: "bug-to-test", args: ["trace", "--workspace", workspace], onLines: { [weak self] lines in
                for line in lines {
                    if let start = line.range(of: "http://127.0.0.1:"), let url = URL(string: String(line[start.lowerBound...]).trimmingCharacters(in: .whitespacesAndNewlines)) {
                        NSWorkspace.shared.open(url)
                        self?.notice = "Local Playwright trace viewer opened. It closes automatically after two minutes."
                    }
                }
            }, onExit: { [weak self] exit in
                if exit.status != 0 && !exit.stopped { self?.error = "Trace viewer failed: " + exit.stderr }
                self?.traceStream = nil
            })
        } catch { self.error = error.localizedDescription }
    }
    func shutdown() async {
        traceStream?.stop(); traceStream = nil
        if isRecording { stopRecording() } else { task?.cancel() }
        await task?.value
        saveTask?.cancel()
        if recording != nil { do { try await persist() } catch { HubPerf.log("bug-to-test: close save failed: \(error)") } }
    }
    func install(_ file: BugToTestRecording) {
        recording = file; title = file.title; result = nil
        if let assertion = file.expectation {
            description = assertion.description; assertionKind = assertion.kind; expected = assertion.expected
            locatorKind = assertion.locator?.kind ?? "testId"; locatorValue = assertion.locator?.value ?? ""; locatorName = assertion.locator?.name ?? ""
        } else {
            description = ""; expected = ""; locatorValue = ""; locatorName = ""; assertionKind = "text"
        }
        if recording?.triggerActionId == nil { recording?.triggerActionId = file.actions.last(where: { !$0.excluded && $0.kind != "navigate" })?.id }
        source = ""

    }
    func loadWorkspace(_ workspace: String) async {
        let identity = epoch
        do {
            try await persist()
            let content = try await command("workspace", args: ["--workspace", workspace, "--input", recordingURL.path], as: BugToTestWorkspace.self)
            guard self.workspace == workspace, epoch == identity else { return }
            source = content.source; result = content.result
        } catch is CancellationError {
            return
        } catch {
            guard self.workspace == workspace, epoch == identity else { return }
            recording?.workspace = nil; source = ""; result = nil
            self.error = "Saved workspace is unavailable: " + error.localizedDescription
        }
    }
    func changed() {
        if busy && !isRecording { task?.cancel() }
        recording?.workspace = nil; result = nil; source = ""
        saveTask?.cancel()
        saveTask = Task {
            do { try await Task.sleep(for: .milliseconds(350)); try await persist() }
            catch is CancellationError { }
            catch { HubPerf.log("bug-to-test: autosave failed: \(error)"); self.error = error.localizedDescription }
        }
    }
    func persist() async throws {
        guard var file = recording else { return }
        file.title = title
        file.expectation = expectation.valid ? expectation : nil
        recording = file
        let data = try JSONEncoder().encode(file); let url = recordingURL
        try await Task.detached {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        }.value
    }
    func editAction(_ id: String, edit: (inout BugToTestAction) -> Void) {
        guard !busy, let index = recording?.actions.firstIndex(where: { $0.id == id }) else { return }
        edit(&recording!.actions[index]); changed()
    }
    func editEvidence(_ id: String, edit: (inout BugToTestEvidence) -> Void) {
        guard !busy, let index = recording?.evidence.firstIndex(where: { $0.id == id }) else { return }
        edit(&recording!.evidence[index]); changed()
    }
    func selectAssertionTarget(_ action: BugToTestAction) {
        guard let locator = action.locator else { return }
        locatorKind = locator.kind; locatorValue = locator.value; locatorName = locator.name ?? ""; changed()
    }
    var runArguments: [String] {
        var args: [String] = []
        if !baseURL.isEmpty { args += ["--base-url", baseURL] }
        if !browserBinary.isEmpty { args += ["--browser", browserBinary] }
        return args
    }
    func generateAndVerify() {
        guard canGenerate else { return }
        perform("Generating and executing the user assertion") {
            try await self.persist()
            let generated = try await self.command("generate", args: ["--input", self.recordingURL.path], as: BugToTestGeneration.self)
            self.recording = generated.recording
            self.progress = "Verifying failure with Playwright in a fresh browser context"
            self.result = try await self.command("verify", args: ["--workspace", generated.directory] + self.runArguments, as: BugToTestResult.self)
            await self.loadWorkspace(generated.directory)
            try await self.persist()
        }
    }
    func rerun() {
        guard let workspace, !busy else { return }
        perform("Rerunning the unchanged assertion") {
            self.result = try await self.command("verify", args: ["--workspace", workspace] + self.runArguments, as: BugToTestResult.self)
            await self.loadWorkspace(workspace)
        }
    }
    func minimize() {
        guard !busy, result?.status == "intended-failure", recording?.triggerActionId != nil else { return }
        perform("Removing steps while preserving the trigger and observed assertion failure") {
            try await self.persist()
            let minimized = try await self.command("minimize", args: ["--input", self.recordingURL.path] + self.runArguments, timeout: 165, as: BugToTestMinimized.self)
            self.recording = minimized.recording; self.result = minimized.result
            await self.loadWorkspace(minimized.directory); try await self.persist()
            self.notice = "Removed \(minimized.recording.removedActionIds?.count ?? 0) unnecessary steps. The trigger and failing assertion were preserved."
        }
    }
    func chooseFixtures() {
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = true; panel.message = "Choose reviewed local fixture files to include in the export."
        panel.begin { response in if response == .OK { self.exportFixtures = panel.urls } }
    }
    func export() {
        guard let workspace, !busy else { return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = "Bug-repro"; panel.message = "Choose a new folder for the portable Playwright bundle."
        panel.begin { response in
            guard response == .OK, let destination = panel.url else { return }
            self.perform("Exporting reviewed repro and trace") {
                var args = ["--workspace", workspace, "--destination", destination.path]
                if !self.exportFixtures.isEmpty { args += ["--fixture"] + self.exportFixtures.map(\.path) }
                let _: [String: String] = try await self.command("export", args: args, as: [String: String].self)
                self.notice = "Portable bundle exported. Run npm install, npx playwright install chromium, then npm test."
                PathOpener.finder(destination.path)
            }
        }
    }
    func saveAs() {
        guard recording != nil, !busy else { return }
        let panel = NSSavePanel(); panel.allowedContentTypes = [.json]; panel.nameFieldStringValue = "Bug-recording.json"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            self.perform("Saving reviewed recording") {
                try await self.persist()
                let source = self.recordingURL
                try await Task.detached { try Data(contentsOf: source).write(to: url, options: .atomic) }.value
                self.notice = "Recording saved. Open it to continue review or rerun."
            }
        }
    }
    func recover() {
        guard !busy else { return }
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]
        panel.directoryURL = recordingURL.deletingLastPathComponent().deletingLastPathComponent()
        panel.message = "Choose a locally autosaved recording to resume review and inspect prior runs."
        panel.begin { response in if response == .OK, let url = panel.url { self.open(url) } }
    }
    func open() {
        guard !busy else { return }
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]; panel.message = "Open a Bug to Test recording. Imported JSON is treated as data."
        panel.begin { response in if response == .OK, let url = panel.url { self.open(url) } }
    }
    func open(_ url: URL) {
        perform("Opening saved recording") {
            let file = try await self.command("inspect", args: ["--input", url.path], as: BugToTestRecording.self)
            self.install(file)
            if let workspace = file.workspace { await self.loadWorkspace(workspace) }
            try await self.persist()
        }
    }
}
