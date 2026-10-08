import AppKit
import Foundation
import SwiftUI

@MainActor
public final class WidgetVoiceRecordingMeter: ObservableObject {
    @Published public private(set) var rms = 0.0
    @Published public private(set) var durationMs = 0.0
    func receive(_ event: VoiceCommandEvent) {
        if let value = event.rms { rms = value }
        if let value = event.durationMs { durationMs = value }
    }
    func reset() { rms = 0; durationMs = 0 }
}

@MainActor
public final class WidgetVoiceNotesStore: ObservableObject {
    @Published public private(set) var notes: [WidgetVoiceNote] = []
    @Published public private(set) var phase: String?
    @Published public private(set) var error: String?
    @Published public private(set) var receipt: String?
    @Published public private(set) var microphonePermission: VoiceMicrophonePermission
    @Published public var presentsMicrophoneAlert = false
    @Published public var selectedID: String?
    @Published public var recipientKey = ""
    @Published private var drafts: [String: String] = [:]
    public let meter = WidgetVoiceRecordingMeter()
    public var recipientPickerVisibilityChanged: (Bool) -> Void = { _ in }
    private let request: ([String]) async throws -> Data
    private let execute: ([String], (any VoiceRecordingLease)?, @escaping (VoiceCommandEvent) -> Void) async throws -> Data
    private let finishCapture: () -> Void
    private let cancelCommand: () -> Void
    private let acquireAudio: () async throws -> any VoiceRecordingLease
    private let settings: () -> WidgetVoiceNoteSettings
    private let sessionsSource: () -> [WidgetSession]
    private let attachDraft: (WidgetSession, WidgetVoiceNote) async throws -> String
    private let micLauncher: String
    private let readMicrophonePermission: () -> VoiceMicrophonePermission
    private let requestMicrophonePermission: () async throws -> VoiceMicrophonePermission
    private let activateForMicrophone: () -> Void
    private let openMicrophoneSettingsAction: () -> Void
    private var operation: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var watcher: DirectoryWatcher?
    private var watchedPath: String?
    private var cached = false
    private var generation = 0
    private var visible = false
    private var stopped = false

    public convenience init(binaryPath: String, stateRoot: String? = nil, micLauncher: String,
        acquireAudio: @escaping () async throws -> any VoiceRecordingLease,
        settings: @escaping () -> WidgetVoiceNoteSettings,
        sessions: @escaping () -> [WidgetSession],
        attachDraft: @escaping (WidgetSession, WidgetVoiceNote) async throws -> String) {
        let bridge = ToolsBridge(binaryPath: binaryPath)
        let transport = VoiceCommandTransport(binaryPath: binaryPath, stateRoot: stateRoot)
        let prefix = ["widget"] + (stateRoot.map { ["--state-root", $0] } ?? []) + ["voice-notes"]
        self.init(micLauncher: micLauncher, request: { args in
            let result = try await bridge.run(subcommand: "hub", args: prefix + args, timeoutSeconds: 15)
            guard result.exitCode == 0 else {
                PerfLog.mark("voice.request exit=\(result.exitCode) \(result.stderr.suffix(1200))")
                throw VoiceCommandFailure.operationFailed
            }
            return Data(result.stdout.utf8)
        }, execute: { args, lease, event in try await transport.run(args: args, lease: lease, onEvent: event) },
        finishCapture: { transport.finishRecording() }, cancelCommand: { transport.cancel() },
        acquireAudio: acquireAudio, settings: settings, sessions: sessions, attachDraft: attachDraft)
    }

    init(micLauncher: String, request: @escaping ([String]) async throws -> Data,
         execute: @escaping ([String], (any VoiceRecordingLease)?, @escaping (VoiceCommandEvent) -> Void) async throws -> Data,
         finishCapture: @escaping () -> Void, cancelCommand: @escaping () -> Void,
         acquireAudio: @escaping () async throws -> any VoiceRecordingLease,
         settings: @escaping () -> WidgetVoiceNoteSettings, sessions: @escaping () -> [WidgetSession],
         attachDraft: @escaping (WidgetSession, WidgetVoiceNote) async throws -> String,
         readMicrophonePermission: @escaping () -> VoiceMicrophonePermission = { .current },
         requestMicrophonePermission: @escaping () async throws -> VoiceMicrophonePermission = { try await VoiceMicrophonePermission.request() },
         activateForMicrophone: @escaping () -> Void = { NSApp?.activate(ignoringOtherApps: true) },
         openMicrophoneSettings: @escaping () -> Void = {
             if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                 NSWorkspace.shared.open(url)
             }
         }) {
        self.micLauncher = micLauncher
        self.readMicrophonePermission = readMicrophonePermission
        self.requestMicrophonePermission = requestMicrophonePermission
        self.activateForMicrophone = activateForMicrophone
        openMicrophoneSettingsAction = openMicrophoneSettings
        microphonePermission = readMicrophonePermission()
        self.request = request
        self.execute = execute
        self.finishCapture = finishCapture
        self.cancelCommand = cancelCommand
        self.acquireAudio = acquireAudio
        self.settings = settings
        sessionsSource = sessions
        self.attachDraft = attachDraft
    }

    public var selected: WidgetVoiceNote? { notes.first { $0.id == selectedID } }
    public var sessions: [WidgetSession] { sessionsSource().filter { ["claude", "codex", "grok"].contains($0.target.provider) } }
    public var isBusy: Bool { phase != nil }
    public var providerLabel: String { settings().provider }
    public var text: String {
        get { guard let selected else { return "" }; return drafts[selected.id] ?? selected.text }
        set { if let selected { drafts[selected.id] = newValue } }
    }

    func visibilityChanged(_ value: WidgetModulePresentation?) {
        visible = value != nil
        if visible { refreshMicrophonePermission(); refresh() }
    }

    public func refresh(force: Bool = false) {
        guard !stopped, refreshTask == nil, force || !cached else { return }
        let requestedGeneration = generation
        refreshTask = Task { [weak self] in
            guard let self else { return }
            defer {
                refreshTask = nil
                if visible && !cached && !stopped { refresh() }
            }
            do {
                let data = try await request(["list", "--json"])
                try Task.checkCancellation()
                guard !stopped, generation == requestedGeneration else { return }
                let snapshot = try JSONDecoder().decode(WidgetVoiceNoteSnapshot.self, from: data)
                notes = snapshot.notes
                drafts = drafts.filter { id, _ in self.notes.contains { $0.id == id } }
                if selected == nil { selectedID = notes.first?.id }
                cached = true
                watch(snapshot.statePath)
            } catch {
                if !Task.isCancelled { report(error) }
                // A failed read waits for an explicit retry or the next file event.
                cached = true
            }
        }
    }

    private func watch(_ path: String) {
        guard watchedPath != path else { return }
        watchedPath = path
        watcher?.stop()
        let file = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        // Watching the existing Widget root also catches first-time creation of voice-notes/.
        let root = ((file as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
        watcher = DirectoryWatcher(paths: [root], latency: 0.2, accepts: { $0 == file }) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.stopped else { return }
                self.generation += 1
                self.cached = false
                if self.visible { self.refresh(force: true) }
            }
        }
    }

    public var microphoneGuidance: String? {
        if phase == "Waiting for microphone permission" {
            return "Waiting for the macOS microphone prompt. Allow access to record, or cancel and review Microphone settings."
        }
        return microphonePermission.guidance
    }

    public func refreshMicrophonePermission() {
        microphonePermission = readMicrophonePermission()
    }

    public func openMicrophoneSettings() {
        openMicrophoneSettingsAction()
    }

    private func prepareMicrophone() async throws {
        refreshMicrophonePermission()
        guard microphonePermission != .authorized else { return }
        activateForMicrophone()
        if microphonePermission == .notDetermined {
            phase = "Waiting for microphone permission"
            microphonePermission = try await requestMicrophonePermission()
            try Task.checkCancellation()
        }
        guard microphonePermission == .authorized else {
            presentsMicrophoneAlert = true
            throw VoiceCommandFailure.microphonePermission
        }
    }

    public func record(input: String = "mic") {
        begin(input == "mic" ? "Checking microphone access" : "Recording") { [self] in
            meter.reset()
            if input == "mic" { try await prepareMicrophone() }
            try Task.checkCancellation()
            phase = "Recording"
            let lease = try await acquireAudio()
            if Task.isCancelled {
                try await lease.release()
                throw CancellationError()
            }
            let data = try await execute(["record", "--input", input, "--mic-launcher", micLauncher,
                                          "--wait-for-start", "--stop-on-stdin", "--json"], lease) { [weak meter] event in
                meter?.receive(event)
            }
            let note = try JSONDecoder().decode(WidgetVoiceNoteResult.self, from: data).note
            put(note)
            selectedID = note.id
            receipt = "Recording saved locally. Transcribe when you are ready."
        }
    }

    public func finishRecording() {
        guard phase == "Recording" else { return }
        phase = "Saving recording"
        finishCapture()
    }

    public func transcribe() {
        guard let note = selected else { return }
        let configuration = settings()
        begin("Transcribing") { [self] in
            let saved = try await save(note)
            var args = ["transcribe", saved.id, "--revision", String(saved.revision), "--provider", configuration.provider]
            if let account = configuration.account { args += ["--account", account] }
            if let model = configuration.model { args += ["--model", model] }
            if let language = configuration.language { args += ["--language", language] }
            let data = try await execute(args, nil) { _ in }
            try Task.checkCancellation()
            let updated = try JSONDecoder().decode(WidgetVoiceNoteResult.self, from: data).note
            put(updated)
            receipt = "Transcript saved. Review it before attaching."
        }
    }

    public func saveText() {
        guard let note = selected else { return }
        begin("Saving text") { [self] in
            _ = try await save(note)
            receipt = "Edited transcript saved locally."
        }
    }

    public func attach() {
        guard let note = selected, let session = sessions.first(where: { $0.key == recipientKey }) else { return }
        begin("Attaching") { [self] in
            let saved = try await save(note)
            guard !saved.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw ToolsBridgeError.refused("Write or transcribe some text before attaching")
            }
            try Task.checkCancellation()
            receipt = try await attachDraft(session, saved)
        }
    }

    public func discard() {
        guard let note = selected else { return }
        begin("Discarding") { [self] in
            _ = try await request(["discard", note.id, "--revision", String(note.revision)])
            generation += 1
            notes.removeAll { $0.id == note.id }
            drafts[note.id] = nil
            selectedID = notes.first?.id
            receipt = "Local recording discarded."
        }
    }

    private func save(_ note: WidgetVoiceNote) async throws -> WidgetVoiceNote {
        let edited = drafts[note.id] ?? note.text
        guard edited != note.text else {
            let data = try await request(["show", note.id, "--revision", String(note.revision)])
            return try JSONDecoder().decode(WidgetVoiceNote.self, from: data)
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("widget-voice-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("text.txt")
        try Data(edited.utf8).write(to: file, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        try Task.checkCancellation()
        let data = try await request(["edit", note.id, "--revision", String(note.revision), "--text-file", file.path])
        let saved = try JSONDecoder().decode(WidgetVoiceNote.self, from: data)
        guard saved.id == note.id, saved.text == edited else { throw ToolsBridgeError.refused("Voice note save returned an inconsistent result") }
        if drafts[note.id] == edited { drafts[note.id] = nil }
        put(saved)
        return saved
    }

    private func put(_ note: WidgetVoiceNote) {
        generation += 1
        if let index = notes.firstIndex(where: { $0.id == note.id }) { notes[index] = note }
        else { notes.insert(note, at: 0) }
        cached = true
    }

    private func begin(_ phase: String, work: @escaping () async throws -> Void) {
        guard !stopped, operation == nil else { return }
        self.phase = phase
        error = nil
        receipt = nil
        operation = Task { [self] in
            defer { self.phase = nil; operation = nil }
            do { try Task.checkCancellation(); try await work() }
            catch {
                if Task.isCancelled || error is CancellationError || (error as? VoiceCommandFailure) == .cancelled {
                    receipt = "Stopped. Existing recordings are kept locally."
                }
                else { report(error) }
                cached = false
                refresh(force: true)
            }
        }
    }

    func waitForOperation() async { await operation?.value }
    func waitForRefresh() async { await refreshTask?.value }
    public func cancel() { operation?.cancel(); cancelCommand() }
    public func shutdown() async {
        stop()
        await operation?.value
        await refreshTask?.value
    }

    public func stop() {
        stopped = true
        cancel()
        refreshTask?.cancel()
        watcher?.stop()
        watcher = nil
    }
    private func report(_ error: Error) {
        if (error as? VoiceCommandFailure) == .microphonePermission {
            refreshMicrophonePermission()
            presentsMicrophoneAlert = microphonePermission != .authorized
        }
        self.error = error.localizedDescription
        PerfLog.mark("widget.voice-notes \(error.localizedDescription)")
    }
}
