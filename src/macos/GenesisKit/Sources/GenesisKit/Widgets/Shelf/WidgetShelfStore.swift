import AppKit
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
    @Published public private(set) var isCapturing = false
    @Published public private(set) var captureAccessGranted: Bool?
    @Published public private(set) var error: String?
    @Published public private(set) var notice: String?
    /// True once the first inventory read finished, so a view can tell a first load from an item arriving.
    @Published public private(set) var loaded = false
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

    public init(
        binaryPath: String, stateRoot: String? = nil,
        recipients: @escaping () -> [WidgetSession],
        didAttach: @escaping (WidgetSession) -> Void,
        onCaptureWillBegin: @escaping () -> Void = {},
        onCaptureStaged: @escaping () -> Void = {},
        onDialogVisibilityChanged: @escaping (Bool) -> Void = { _ in },
        attachToDraft: ((WidgetShelfItem, WidgetSession) async throws -> Void)? = nil
    ) {
        screenCaptureAccess = { PermissionAccess.live.isGranted(.screenRecording) }
        permissionGate = { await PermissionCenter.shared.ensure($0) }
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
        recipients: @escaping () -> [WidgetSession] = { [] },
        didAttach: @escaping (WidgetSession) -> Void = { _ in },
        onCaptureWillBegin: @escaping () -> Void = {},
        onCaptureStaged: @escaping () -> Void = {},
        onDialogVisibilityChanged: @escaping (Bool) -> Void = { _ in },
        attachToDraft: ((WidgetShelfItem, WidgetSession) async throws -> Void)? = nil
    ) {
        self.request = request
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
                    if self.items != snapshot.items {
                        self.captureItems = snapshot.items.filter { $0.kind == .capture }
                        self.items = snapshot.items
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
            reason: "Capture takes a screenshot of the area you select and stages it in the widget.",
            grantWorksInNewProcess: true,
            onGranted: { [weak self] in self?.capture() })
    }

    private func beginCapture(allowed: Bool) {
        isCapturing = true
        onCaptureWillBegin()
        start(success: "Screenshot staged. Choose an inbox when you are ready.") {
            do {
                let data = try await self.request(["capture"], 125)
                if try JSONDecoder().decode(WidgetShelfCaptureResponse.self, from: data).cancelled == true {
                    throw CancellationError()
                }
                let item = try JSONDecoder().decode(WidgetShelfItem.self, from: data)
                guard item.kind == .capture else { throw ToolsBridgeError.refused("Capture returned no image.") }
            } catch {
                if error is CancellationError || Task.isCancelled { throw error }
                let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                    ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "this app"
                let advice = allowed ? "" : "\nAllow \(app) to record the screen in System Settings → Privacy & Security, then reopen the app."
                throw ToolsBridgeError.refused(error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines) + advice)
            }
        }
    }

    public func cancelCapture() {
        guard isCapturing else { return }
        operation?.cancel()
    }

    public func importFiles(_ urls: [URL], asImages: Bool = false) {
        guard !stopped, !isBusy, !urls.isEmpty else { return }
        guard urls.allSatisfy(\.isFileURL) else {
            error = "Only local files can be staged."
            return
        }
        start(success: urls.count == 1 ? "Item staged." : "\(urls.count) items staged.") {
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
        panel.prompt = asImages ? "Stage images" : "Add to shelf"
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
        start(success: "Clipboard image staged.") {
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

    public func remove(_ item: WidgetShelfItem) {
        start(success: "Removed from the shelf. Files and existing drafts are preserved.") {
            _ = try await self.request(["remove", item.id], 15)
        }
    }

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
                } else {
                    self.report(error)
                }
            }
        }
    }

    private func report(_ error: Error) {
        self.error = error.localizedDescription
        GenesisKit.log("widget shelf: \(error.localizedDescription)")
    }

    deinit {
        watcher?.stop()
        refreshTask?.cancel()
        operation?.cancel()
    }
}
