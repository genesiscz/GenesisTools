import AppKit
import Combine
import CoreGraphics
import SwiftUI

public struct WidgetShelfItem: Codable, Identifiable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case file, capture }
    public let id: String
    public let kind: Kind
    public let name: String
    public let path: String
    public let sourcePath: String?
    public let sha256: String
    public let bytes: Int64
    public let createdAt: Double
    public let assetId: String?

    /// A capture that is a screen recording rather than a screenshot (by its file's extension).
    public var isVideo: Bool { MediaKind.of(path: path) == .video }
}

struct WidgetShelfAttachment: Codable, Sendable {
    let mode: String
    let reference: String?
    let assetId: String?
    let draft: WidgetDraft

    func merging(into draft: WidgetDraft) throws -> WidgetDraft {
        var result = draft
        if mode == "image", let assetId {
            if !result.assetIds.contains(assetId) { result.assetIds.append(assetId) }
        } else if mode == "file-reference", let reference, !reference.isEmpty {
            if !result.text.contains(reference) {
                result.text = [result.text, reference].filter { !$0.isEmpty }.joined(separator: "\n\n")
            }
        } else {
            throw ToolsBridgeError.refused("The shelf item has no usable draft attachment.")
        }
        return result
    }
}

private struct WidgetShelfCaptureResponse: Decodable {
    let cancelled: Bool?
}

struct WidgetShelfSnapshot: Decodable, Sendable {
    let revision: Int
    let items: [WidgetShelfItem]
    let statePath: String
}

/// Capture and File Shelf share one inventory and one mutation owner across every edge surface.
@MainActor
public final class WidgetShelfStore: ObservableObject {
    @Published public private(set) var items: [WidgetShelfItem] = []
    @Published public private(set) var isBusy = false
    /// The area selection is up; VoiceOver hears it, since the screen changes without a click in the shelf.
    @Published public private(set) var isCapturing = false {
        didSet { if isCapturing, !oldValue { announce("Select an area to capture. Press Escape to cancel.", .medium) } }
    }
    @Published public private(set) var captureAccessGranted: Bool?
    /// The status line's failure; it arrives after the action that caused it, so VoiceOver hears it.
    @Published public private(set) var error: String? {
        didSet { if let error, error != oldValue { announce(Self.spoken(error), .high) } }
    }
    @Published public private(set) var notice: String? {
        didSet { if let notice, notice != oldValue { announce(notice, .medium) } }
    }
    /// The item the user just removed: gone from the list, still on the shelf until `undoSeconds` run out, so
    /// the status line's Undo can bring it back (ux checklist "Undo and destructive actions").
    @Published public private(set) var removed: WidgetShelfItem?
    /// True once the first inventory read finished, so a view can tell a first load from an item arriving.
    @Published public private(set) var loaded = false
    /// A screen recording started from the Capture shelf runs (from its picker until it ends).
    @Published public private(set) var isRecording = false
    /// "Record screen…": GenesisKit's generic recorder; "Stop and save" stages the movie here as a capture.
    private let screenRecorder: ScreenRecorder?
    private var recorderActivity: AnyCancellable?
    private let request: ([String], Int) async throws -> Data
    private let recipientSource: () -> [WidgetSession]
    private let didAttach: (WidgetSession) -> Void
    private let attachToDraft: ((WidgetShelfItem, WidgetSession) async throws -> Void)?
    private let onCaptureWillBegin: () -> Void
    /// After a capture that staged an image; a host reopens the shelf so the new item is seen arriving.
    private let onCaptureStaged: () -> Void
    private let onDialogVisibilityChanged: (Bool) -> Void
    private let screenCaptureAccess: () -> Bool
    /// Screen Recording for a capture: true when the screenshot may run, otherwise the permission dialog is up.
    private let permissionGate: @MainActor (PermissionNeed) async -> Bool
    private var checkingCaptureAccess = false
    private var visibleModules: Set<String> = []
    private var watcher: DirectoryWatcher?
    private var statePath: String?
    private var captureItems: [WidgetShelfItem] = []
    private var refreshTask: Task<Void, Never>?
    private var refreshAgain = false
    private var operation: Task<Void, Never>?
    private var isChoosingFiles = false
    private var filePicker: NSOpenPanel?
    private var stopped = false
    private let announce: @MainActor (String, GenAnnounce.Priority) -> Void
    /// How long a removal waits behind Undo (`WidgetModel.undoSeconds`), read at each removal.
    private let undoSeconds: @MainActor () -> Double
    /// Where the removed item stood, so Undo puts it back in place.
    private var removedIndex = 0
    private var removalTimer: Task<Void, Never>?
    /// The CLI removal once the Undo ran out; teardown waits for it.
    private var removal: Task<Void, Never>?

    public init(
        binaryPath: String, stateRoot: String? = nil,
        recipients: @escaping () -> [WidgetSession],
        didAttach: @escaping (WidgetSession) -> Void,
        onCaptureWillBegin: @escaping () -> Void = {},
        onCaptureStaged: @escaping () -> Void = {},
        onDialogVisibilityChanged: @escaping (Bool) -> Void = { _ in },
        attachToDraft: ((WidgetShelfItem, WidgetSession) async throws -> Void)? = nil,
        undoSeconds: @escaping @MainActor () -> Double = { WidgetModel.undoSeconds(nil) }
    ) {
        screenCaptureAccess = { PermissionAccess.live.isGranted(.screenRecording) }
        permissionGate = { await PermissionCenter.shared.ensure($0) }
        announce = { GenAnnounce.post($0, priority: $1) }
        self.undoSeconds = undoSeconds
        let bridge = ToolsBridge(binaryPath: binaryPath)
        self.request = { arguments, timeout in
            var prefix = ["widget"]
            if let stateRoot { prefix += ["--state-root", stateRoot] }
            let result = try await bridge.run(
                subcommand: "hub", args: prefix + ["shelf"] + arguments, timeoutSeconds: timeout
            )
            guard result.exitCode == 0 else {
                throw ToolsBridgeError.refused(String(result.stderr.suffix(1200)))
            }
            return Data(result.stdout.utf8)
        }
        screenRecorder = ScreenRecorder(bridge: bridge)
        recipientSource = recipients
        self.didAttach = didAttach
        self.onCaptureWillBegin = onCaptureWillBegin
        self.onCaptureStaged = onCaptureStaged
        self.onDialogVisibilityChanged = onDialogVisibilityChanged
        self.attachToDraft = attachToDraft
    }

    init(
        request: @escaping ([String], Int) async throws -> Data,
        screenCaptureAccess: @escaping () -> Bool = { true },
        permissionGate: @escaping @MainActor (PermissionNeed) async -> Bool = { _ in true },
        screenRecorder: ScreenRecorder? = nil,
        recipients: @escaping () -> [WidgetSession] = { [] },
        didAttach: @escaping (WidgetSession) -> Void = { _ in },
        onCaptureWillBegin: @escaping () -> Void = {},
        onCaptureStaged: @escaping () -> Void = {},
        onDialogVisibilityChanged: @escaping (Bool) -> Void = { _ in },
        attachToDraft: ((WidgetShelfItem, WidgetSession) async throws -> Void)? = nil,
        announce: @escaping @MainActor (String, GenAnnounce.Priority) -> Void = { _, _ in },
        undoSeconds: @escaping @MainActor () -> Double = { 10 }
    ) {
        self.request = request
        self.announce = announce
        self.undoSeconds = undoSeconds
        self.screenRecorder = screenRecorder
        self.screenCaptureAccess = screenCaptureAccess
        self.permissionGate = permissionGate
        recipientSource = recipients
        self.didAttach = didAttach
        self.onCaptureWillBegin = onCaptureWillBegin
        self.onCaptureStaged = onCaptureStaged
        self.onDialogVisibilityChanged = onDialogVisibilityChanged
        self.attachToDraft = attachToDraft
    }

    /// Coordinator teardown is terminal for this store; hiding a module leaves active staging alone.
    public func stop() {
        guard !stopped else { return }
        // The user removed it; teardown must not put it back on the shelf.
        commitRemoval()
        stopped = true
        visibleModules.removeAll()
        watcher?.stop()
        watcher = nil
        refreshAgain = false
        refreshTask?.cancel()
        refreshTask = nil
        operation?.cancel()
        operation = nil
        isBusy = false
        isCapturing = false
        filePicker?.cancel(nil)
        finishChoosingFiles()
        statePath = nil
        error = nil
        notice = nil
    }

    public var recipients: [WidgetSession] { recipientSource() }
    public var captures: [WidgetShelfItem] { captureItems }

    func visibilityChanged(module: String, presentation: WidgetModulePresentation?) {
        guard !stopped else { return }
        if presentation != nil {
            // A running watcher already refreshes on every state change; only a shelf nobody watched needs a read.
            let watching = watcher != nil
            visibleModules.insert(module)
            if !watching { refresh() }
        } else {
            visibleModules.remove(module)
        }
        updateWatcher()
    }

    public func refresh() {
        guard !stopped else { return }
        guard refreshTask == nil else {
            refreshAgain = true
            return
        }
        refreshTask = Task { [weak self] in
            guard let self, !self.stopped, !Task.isCancelled else { return }
            repeat {
                self.refreshAgain = false
                do {
                    let data = try await self.request(["list", "--json"], 15)
                    guard !self.stopped, !Task.isCancelled else { return }
                    let snapshot = try JSONDecoder().decode(WidgetShelfSnapshot.self, from: data)
                    // A removed item stays on disk during its Undo; it stays off the list.
                    let shown = snapshot.items.filter { $0.id != self.removed?.id }
                    if self.items != shown {
                        self.captureItems = shown.filter { $0.kind == .capture }
                        self.items = shown
                    }
                    self.statePath = snapshot.statePath
                    if !self.loaded { self.loaded = true }
                    self.updateWatcher()
                } catch {
                    if !self.stopped, !Task.isCancelled { self.report(error) }
                }
            } while self.refreshAgain && !Task.isCancelled
            self.refreshTask = nil
        }
    }

    private func updateWatcher() {
        guard !visibleModules.isEmpty, let statePath else {
            watcher?.stop()
            watcher = nil
            return
        }
        guard watcher == nil else { return }
        let resolvedPath = URL(fileURLWithPath: statePath).resolvingSymlinksInPath().path
        watcher = DirectoryWatcher(
            paths: [(resolvedPath as NSString).deletingLastPathComponent],
            accepts: { $0 == resolvedPath }
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    public func capture() {
        guard !stopped, !isBusy, !checkingCaptureAccess else { return }
        let allowed = screenCaptureAccess()
        captureAccessGranted = allowed
        PerfLog.mark("widget.capture.preflight pid=\(ProcessInfo.processInfo.processIdentifier) screenRecording=\(allowed)")
        guard !allowed else {
            beginCapture(allowed: true)
            return
        }

        // This process may hold an old answer, and the screenshot runs in a new process that reads the grant
        // again: the gate asks one, and shows the permission dialog only when the grant is really missing.
        checkingCaptureAccess = true
        Task { [weak self] in
            guard let self else { return }
            let ready = await self.permissionGate(self.screenRecordingNeed)
            self.checkingCaptureAccess = false
            guard !self.stopped else { return }
            if ready {
                self.beginCapture(allowed: false)
            } else {
                self.notice = "Capture needs Screen Recording. The permission window shows how to allow it."
            }
        }
    }

    private var screenRecordingNeed: PermissionNeed {
        PermissionNeed(
            .screenRecording,
            reason: "Capture takes a screenshot of the area you select and keeps it in the widget until you choose an inbox.",
            grantWorksInNewProcess: true,
            onGranted: { [weak self] in self?.capture() })
    }

    private func beginCapture(allowed: Bool) {
        // The permission gate can take seconds; an import, paste or attach started meanwhile owns the shelf, and a
        // capture begun now would collapse the widget and show "Cancel capture" for that other operation.
        guard !stopped, !isBusy else { return }
        isCapturing = true
        onCaptureWillBegin()
        start(success: "Screenshot added. Choose an inbox when you are ready.") {
            do {
                let data = try await self.request(["capture"], 125)
                if try JSONDecoder().decode(WidgetShelfCaptureResponse.self, from: data).cancelled == true {
                    throw CancellationError()
                }
                let item = try JSONDecoder().decode(WidgetShelfItem.self, from: data)
                guard item.kind == .capture else { throw ToolsBridgeError.refused("Capture returned no image.") }
            } catch {
                if error is CancellationError || Task.isCancelled { throw error }
                if WidgetCaptureError.isScreenRecordingDenied(error) { throw CaptureDenied() }
                let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                    ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "this app"
                let advice = allowed ? "" : "\nAllow \(app) to record the screen in System Settings → Privacy & Security, then reopen the app."
                throw ToolsBridgeError.refused(error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines) + advice)
            }
        }
    }

    /// The screenshot's own process found no grant: it was revoked after the check, or this process read an old yes.
    private struct CaptureDenied: Error {}

    /// Opens the permission dialog for a capture macOS refused, as the composer's camera button does; its retry
    /// captures again once the grant is on. When even the gate reads the grant as on, no dialog can come up, so the
    /// shelf says where to turn it on instead of retrying into the same refusal.
    private func recoverScreenRecording() {
        captureAccessGranted = false
        notice = "Capture needs Screen Recording. The permission window shows how to allow it."
        Task { [weak self] in
            guard let self, await self.permissionGate(self.screenRecordingNeed), !self.stopped else { return }
            self.notice = nil
            self.report(ToolsBridgeError.refused(
                "macOS refused the screenshot: Screen Recording is off for this app. Allow it in System Settings → Privacy & Security, then reopen the app."))
        }
    }

    public func cancelCapture() {
        guard isCapturing else { return }
        operation?.cancel()
    }

    /// Whether "Record screen…" can run here (the store has a recorder; previews and tests may not).
    public var canRecord: Bool { screenRecorder != nil && !stopped }

    /// "Record screen…": the person picks a window, an app or a display, records it with the floating controls, and
    /// "Stop and save" stages the movie here as a capture, ready for any inbox with the frame review of a video.
    public func recordScreen() {
        guard !stopped, let screenRecorder else { return }
        recorderActivity = screenRecorder.$isActive.removeDuplicates().sink { [weak self] active in
            self?.isRecording = active
        }
        screenRecorder.begin(host: ScreenRecordingHost(
            useTitle: "Stop and save",
            permissionReason: "Record screen records the window, app or display you choose and keeps the movie on the shelf until you choose an inbox.",
            onUse: { [weak self] movie in try await self?.stageRecording(movie) },
            onDiscard: { [weak self] in self?.notice = "Recording discarded." },
            onError: { [weak self] message in self?.report(ToolsBridgeError.refused(message)) },
            onStart: { [weak self] in self?.onCaptureWillBegin() }))
    }

    public func showRecordingControls() {
        screenRecorder?.showControls()
    }

    /// Stages a finished recording as a capture, then removes the recorder's file (the shelf keeps its own copy).
    func stageRecording(_ movie: URL) async throws {
        guard !stopped else { return }
        let stamp = Date().formatted(.dateTime.hour().minute().second())
        let data = try await request(["video", movie.path, "--name", "Screen recording \(stamp).mp4"], 300)
        let item = try JSONDecoder().decode(WidgetShelfItem.self, from: data)
        guard item.kind == .capture else { throw ToolsBridgeError.refused("The recording could not be added as a capture.") }
        do { try FileManager.default.removeItem(at: movie) } catch {
            GenesisKit.log("widget shelf: recording cleanup \(error.localizedDescription)")
        }
        guard !stopped else { return }
        notice = "Recording added. Choose an inbox when you are ready."
        refresh()
        onCaptureStaged()
    }

    public func importFiles(_ urls: [URL], asImages: Bool = false) {
        guard !stopped, !isBusy, !urls.isEmpty else { return }
        guard urls.allSatisfy(\.isFileURL) else {
            error = "Only local files can be added."
            return
        }
        start(success: urls.count == 1 ? "Item added." : "\(urls.count) items added.") {
            var failures: [String] = []
            for url in urls {
                try Task.checkCancellation()
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                do {
                    _ = try await self.request([asImages ? "image" : "import", url.path], 120)
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    failures.append("\(url.lastPathComponent): \(error.localizedDescription)")
                }
            }
            if !failures.isEmpty { throw ToolsBridgeError.refused(failures.joined(separator: "\n")) }
        }
    }

    public func chooseFiles(asImages: Bool = false) {
        guard !stopped, !isBusy, !isChoosingFiles else { return }
        isChoosingFiles = true
        onDialogVisibilityChanged(true)
        let panel = NSOpenPanel()
        filePicker = panel
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.prompt = asImages ? "Add images" : "Add to shelf"
        if asImages { panel.allowedContentTypes = [.image] }
        panel.begin { [weak self] response in
            Task { @MainActor in
                self?.finishChoosingFiles()
                guard response == .OK else { return }
                self?.importFiles(panel.urls, asImages: asImages)
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    private func finishChoosingFiles() {
        guard isChoosingFiles else { return }
        isChoosingFiles = false
        filePicker = nil
        onDialogVisibilityChanged(false)
    }

    public func paste(asImages: Bool = false) {
        guard !stopped, !isBusy else { return }
        let pasteboard = NSPasteboard.general
        let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if !urls.isEmpty {
            importFiles(urls, asImages: asImages)
            return
        }
        guard let data = pasteboard.data(forType: .png) ?? pasteboard.data(forType: .tiff) else {
            error = "Copy a file or image first."
            return
        }
        start(success: "Clipboard image added.") {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("widget-paste-\(UUID().uuidString)", isDirectory: true)
            let temporary = directory.appendingPathComponent("Clipboard image.png")
            try await Task.detached(priority: .userInitiated) {
                guard let bitmap = NSBitmapImageRep(data: data), let png = bitmap.representation(using: .png, properties: [:]) else {
                    throw ToolsBridgeError.refused("The clipboard image could not be read.")
                }
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try png.write(to: temporary, options: .atomic)
            }.value
            defer {
                do { try FileManager.default.removeItem(at: directory) }
                catch { GenesisKit.log("shelf paste cleanup: \(error.localizedDescription)") }
            }
            try Task.checkCancellation()
            _ = try await self.request(["image", temporary.path], 120)
        }
    }

    /// Takes `item` off the list at once and removes it from the shelf after `undoSeconds`, unless Undo brings
    /// it back first. Removing another item removes the first one now.
    public func remove(_ item: WidgetShelfItem) {
        guard !stopped, !isBusy, let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        commitRemoval()
        removed = item
        removedIndex = index
        items.remove(at: index)
        captureItems.removeAll { $0.id == item.id }
        error = nil
        // A capture has no original elsewhere; a file does.
        notice = item.kind == .capture ? "Removed from Capture. Drafts that already use it keep it."
            : "Removed from the shelf. The original file and existing drafts are kept."
        let delay = Duration.seconds(undoSeconds())
        removalTimer = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            self?.commitRemoval()
        }
    }

    /// Undo of Remove from shelf: the item comes back in its place.
    public func undoRemove() {
        guard let item = removed else { return }
        removalTimer?.cancel()
        removalTimer = nil
        removed = nil
        if !items.contains(where: { $0.id == item.id }) {
            items.insert(item, at: min(removedIndex, items.count))
            captureItems = items.filter { $0.kind == .capture }
        }
        notice = "\(item.name) is back" + (item.kind == .capture ? "." : " on the shelf.")
        refresh()
    }

    /// The Undo row's close button: the removal happens now instead of when the Undo time runs out.
    public func confirmRemoval() { commitRemoval() }

    /// Removes the item for good: its Undo ran out or was closed, another item was removed, or the store stops.
    private func commitRemoval() {
        guard let item = removed else { return }
        removalTimer?.cancel()
        removalTimer = nil
        removed = nil
        let previous = removal
        // The request is held, not the store: a removal that runs at teardown still reaches the CLI.
        let request = request
        removal = Task { [weak self] in
            await previous?.value
            do {
                _ = try await request(["remove", item.id], 15)
            } catch {
                // Still on the shelf: say why; the list read below shows it again.
                if let self, !self.stopped { self.report(error) }
            }
            if let self, !self.stopped { self.refresh() }
        }
    }

    func waitForRemoval() async { await removal?.value }

    public func attach(_ item: WidgetShelfItem, to recipient: WidgetSession) {
        start(success: "Added to inbox draft. Nothing has been sent.") {
            if let attachToDraft = self.attachToDraft {
                try await attachToDraft(item, recipient)
            } else {
                _ = try await self.request(["attach", item.id, "--session-key", recipient.key], 15)
            }
            try Task.checkCancellation()
            guard !self.stopped else { return }
            self.didAttach(recipient)
        }
    }

    private func start(success: String, action: @escaping () async throws -> Void) {
        guard !stopped, !isBusy else { return }
        let capturing = isCapturing
        isBusy = true
        error = nil
        notice = nil
        operation = Task { [weak self] in
            guard let self else { return }
            // Reset even when cancelled before the first line ran, or the shelf stays busy forever.
            defer {
                self.isBusy = false
                self.isCapturing = false
                self.operation = nil
                self.refresh()
            }
            guard !self.stopped else { return }
            do {
                try Task.checkCancellation()
                try await action()
                try Task.checkCancellation()
                guard !self.stopped else { return }
                self.notice = success
                if capturing { self.onCaptureStaged() }
            } catch {
                guard !self.stopped else { return }
                if Task.isCancelled || error is CancellationError {
                    self.notice = "Capture cancelled."
                } else if error is CaptureDenied {
                    self.recoverScreenRecording()
                } else {
                    self.report(error)
                }
            }
        }
    }

    private func report(_ error: Error) {
        // A reply the shelf cannot decode is one sentence on screen; the decoder's own words go to the log only.
        self.error = error is DecodingError ? "The shelf could not be read. Try again in a moment." : error.localizedDescription
        GenesisKit.log("widget shelf: \(error.localizedDescription)")
    }

    /// The first line of an error, short enough for VoiceOver to read out.
    nonisolated static func spoken(_ error: String) -> String {
        let line = error.split(whereSeparator: \.isNewline).first.map(String.init) ?? error
        return line.count > 160 ? String(line.prefix(157)) + "…" : line
    }

    deinit {
        watcher?.stop()
        refreshTask?.cancel()
        operation?.cancel()
    }
}
