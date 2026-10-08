import AppKit
import Combine
import SwiftUI
import XCTest
@testable import GenesisKit

final class CmuxTreeTests: XCTestCase {
    private let json = """
    profile: cmux tree 12ms
    {"fetchedAt":"2026-09-30T00:00:00Z","available":true,"windows":[{"id":"W1","ref":"window:1","index":0,"key":true,
    "workspaces":[{"id":"workspace:1","name":"work","panes":[
    {"id":"pane:1","title":"pane:1","active":true,"cwd":"/tmp","frame":{"x":0,"y":28,"width":800,"height":600},
     "container":{"width":1600,"height":1200},"selectedSurfaceId":"surface:2","surfaces":[
      {"id":"surface:1","title":"shell","type":"terminal","index":0,"selected":false,"active":false,"sessionId":null,"provider":null,"sessionHint":null},
      {"id":"surface:2","title":"fix the cart","type":"terminal","index":1,"selected":true,"active":true,"sessionId":"0A1B2C3D-4E5F","provider":"claude"}]},
    {"id":"pane:2","surfaces":[{"id":"surface:3","sessionHint":"deadbeef"}]}]}]}],"totalMs":12}
    """

    func testDecodesBothAppsFieldsAfterAPreamble() throws {
        let tree = try CmuxTree.decode(Data(json.utf8))
        XCTAssertTrue(tree.available)
        XCTAssertEqual(tree.windows.first?.label, "window:1")
        let pane = try XCTUnwrap(tree.windows.first?.workspaces.first?.panes.first)
        XCTAssertEqual(pane.frame, CmuxTree.Frame(x: 0, y: 28, width: 800, height: 600))
        XCTAssertEqual(pane.selectedSurfaceId, "surface:2")
        XCTAssertEqual(pane.surfaces.last?.provider, "claude")
        let sparse = try XCTUnwrap(tree.windows.first?.workspaces.first?.panes.last)
        XCTAssertNil(sparse.frame, "an older tools prints no frame")
        XCTAssertEqual(sparse.surfaces.first?.type, "terminal")
    }

    func testFindsASessionByIdOrHint() throws {
        let tree = try CmuxTree.decode(Data(json.utf8))
        XCTAssertEqual(tree.surface(of: "0a1b2c3d-4e5f")?.surface.id, "surface:2")
        XCTAssertEqual(tree.surface(of: "DEADBEEF-0000")?.surface.id, "surface:3")
        XCTAssertNil(tree.surface(of: "11111111-2222"))
        XCTAssertTrue(tree.hostsSession("0A1B2C3D-4E5F"))
        XCTAssertFalse(tree.hostsSession("11111111"))
    }

    func testAnUnreachableCmuxDecodesWithItsError() throws {
        let tree = try CmuxTree.decode(Data(#"{"available":false,"error":"cmux is not running","windows":[]}"#.utf8))
        XCTAssertFalse(tree.available)
        XCTAssertEqual(tree.error, "cmux is not running")
    }

    func testTargetsNameTheirOpenSessionFlags() {
        XCTAssertNil(CmuxTarget.newWorkspace(window: nil).openSessionArgs)
        XCTAssertEqual(CmuxTarget.newWorkspace(window: "window:1").openSessionArgs, ["--window", "window:1"])
        XCTAssertEqual(CmuxTarget.newPane(workspace: "workspace:1").openSessionArgs, ["--workspace", "workspace:1"])
        XCTAssertEqual(CmuxTarget.newTab(workspace: "w", pane: "p").openSessionArgs, ["--workspace", "w", "--pane", "p"])
        XCTAssertEqual(CmuxTarget.surface(workspace: "w", surface: "s").openSessionArgs, ["--workspace", "w", "--surface", "s"])
    }

    func testLastPanePrefersThePaneThenTheTab() {
        XCTAssertEqual(CmuxTarget.lastPane(workspace: "w", pane: "p", surface: "s"), .newTab(workspace: "w", pane: "p"))
        XCTAssertEqual(CmuxTarget.lastPane(workspace: "w", pane: "", surface: "s"), .surface(workspace: "w", surface: "s"))
        XCTAssertNil(CmuxTarget.lastPane(workspace: nil, pane: "p", surface: "s"))
    }

    /// The layout scales the panes to the width it is given, never the other way round: a fixed
    /// drawing width made the hub's sidebar wider than its panel.
    func testTheLayoutFitsThePanesIntoTheGivenWidth() {
        let frames = [CmuxTree.Frame(x: 240, y: 28, width: 885, height: 629), CmuxTree.Frame(x: 1125, y: 28, width: 930, height: 629)]
        let narrow = CmuxLayoutView.fit(frames, width: 260)
        XCTAssertEqual((2055 - 240) * narrow.scale, 260, accuracy: 0.5)
        XCTAssertEqual(narrow.height, 629 * narrow.scale, accuracy: 0.5)
        XCTAssertEqual(CmuxLayoutView.fit([], width: 0).height, 40, "an empty or unmeasured workspace keeps a minimum height")
    }

    func testRefsDropEmptyOnesAndKeepTheNumber() {
        let refs = CmuxSessionPanel.refs(window: "window:1", workspace: "", pane: "pane:37", surface: "surface")
        XCTAssertEqual(refs.map(\.label), ["window", "pane", "tab"])
        XCTAssertEqual(refs.map(\.value), ["1", "37", "surface"])
    }
}

@MainActor
final class MenuButtonTests: XCTestCase {
    /// AppKit sends the item's selector to its target. `perform:` resolved to NSObject's
    /// `performSelector:`, so every pick did nothing (Genesis's copy still had it until 2026-09-30).
    func testAPickThroughAppKitRunsTheItemsClosure() {
        _ = NSApplication.shared
        var picked: [String] = []
        let menu = MenuButtonPresenter.menu([
            .action("Minimal") { picked.append("minimal") },
            .divider,
            .action("Verbose", checked: true) { picked.append("verbose") },
            .submenu("More", [.note("Nothing here")]),
        ])
        XCTAssertEqual(menu.items.map(\.title), ["Minimal", "", "Verbose", "More"])
        XCTAssertEqual(menu.items[2].state, .on)
        menu.performActionForItem(at: 2)
        XCTAssertEqual(picked, ["verbose"])
    }
}

final class PathOpenerTests: XCTestCase {
    func testTheTargetTableOpensFoldersInFinderAndFilesInTheEditor() {
        let url = URL(fileURLWithPath: "/x")
        XCTAssertEqual(PathOpener.target(for: url, intent: .primary, kind: .folder), .folderInFinder(url))
        XCTAssertEqual(PathOpener.target(for: url, intent: .primary, kind: .file, line: 3), .editFile(url, line: 3))
        XCTAssertEqual(PathOpener.target(for: url, intent: .finder, kind: .package), .revealInFinder(url))
        XCTAssertEqual(PathOpener.target(for: url, intent: .open, kind: .missing), .missing("/x"))
    }

    func testTheCopyToastPreviewIsOneShortLine() {
        XCTAssertEqual(CopyToast.preview("one\ntwo"), "2 lines")
        XCTAssertEqual(CopyToast.preview(String(repeating: "a", count: 100), limit: 21).count, 21)
    }

    func testAHomePathShowsWithATilde() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        XCTAssertEqual(PathLabel.display(home + "/Projects/x"), "~/Projects/x")
        XCTAssertEqual(PathLabel.display("/tmp/x"), "/tmp/x")
        XCTAssertEqual(PathLabel.display(home), "~")
        XCTAssertEqual(PathLabel.display(home + "x/y"), home + "x/y", "a sibling of the home folder keeps its path")
    }
}

@MainActor
final class SpinningArcTests: XCTestCase {
    func testPathMatchesCircleStrokeWithoutAnInsetAndResizes() throws {
        let view = SpinningArc.ArcView(frame: CGRect(x: 0, y: 0, width: 9, height: 9))
        view.configure(color: NSColor.blue.cgColor, lineWidth: 2, trim: 0.12...0.78, period: 1.65, spinning: false)
        view.layout()
        let arc = try XCTUnwrap(view.layer?.sublayers?.first as? CAShapeLayer)
        XCTAssertEqual(try XCTUnwrap(arc.path).boundingBoxOfPath, Circle().path(in: view.bounds).boundingRect)
        XCTAssertEqual(arc.strokeStart, 0.12)
        XCTAssertEqual(arc.strokeEnd, 0.78)
        XCTAssertEqual(arc.lineCap, .round)
        view.setFrameSize(CGSize(width: 20, height: 30))
        view.layout()
        XCTAssertEqual(try XCTUnwrap(arc.path).boundingBoxOfPath, CGRect(x: 0, y: 5, width: 20, height: 20))
    }

    func testSpinAttachesStopsAndReattachesWithoutChangingTrim() throws {
        _ = NSApplication.shared
        let window = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 40, height: 40),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let view = SpinningArc.ArcView(frame: CGRect(x: 0, y: 0, width: 20, height: 20))
        view.configure(color: NSColor.blue.cgColor, lineWidth: 2, trim: 0.12...0.78, period: 1.65, spinning: true)
        let arc = try XCTUnwrap(view.layer?.sublayers?.first as? CAShapeLayer)
        XCTAssertNil(arc.animation(forKey: "genesis.spin"))
        window.contentView = view
        let spin = try XCTUnwrap(arc.animation(forKey: "genesis.spin") as? CABasicAnimation)
        XCTAssertEqual(spin.duration, 1.65)
        XCTAssertEqual(try XCTUnwrap(spin.toValue as? Double), -2 * .pi)
        XCTAssertEqual(spin.repeatCount, .infinity)
        view.removeFromSuperview()
        XCTAssertNil(arc.animation(forKey: "genesis.spin"))
        window.contentView = view
        XCTAssertNotNil(arc.animation(forKey: "genesis.spin"))
        view.configure(color: NSColor.blue.cgColor, lineWidth: 2, trim: 0.12...0.78, period: 1.65, spinning: false)
        XCTAssertNil(arc.animation(forKey: "genesis.spin"))
        XCTAssertEqual(arc.strokeStart, 0.12)
        XCTAssertEqual(arc.strokeEnd, 0.78)
    }
}

@MainActor
final class WidgetShelfStoreTests: XCTestCase {
    private let item = WidgetShelfItem(
        id: "fixture-item", kind: .file, name: "notes.pdf", path: "/fixture/managed/notes.pdf",
        sourcePath: "/fixture/original/notes.pdf", sha256: "fixture-hash", bytes: 128,
        createdAt: 1, assetId: nil
    )
    private let empty = Data(#"{"revision":0,"items":[],"statePath":"/fixture/widget-shelf/state.json"}"#.utf8)

    private func complete(_ store: WidgetShelfStore, action: () -> Void) async {
        let finished = expectation(description: "Shelf operation finishes")
        let subscription = store.$isBusy.dropFirst().filter { !$0 }.prefix(1).sink { _ in finished.fulfill() }
        action()
        await fulfillment(of: [finished], timeout: 2)
        withExtendedLifetime(subscription) {}
    }

    func testGeneralImportNeverCallsImageOrAttachAndOwnerRejectsConcurrentMutation() async {
        var calls: [[String]] = []
        let store = WidgetShelfStore(request: { args, _ in
            calls.append(args)
            return self.empty
        })
        await complete(store) {
            store.importFiles([URL(fileURLWithPath: "/fixture/report.pdf")])
            store.capture()
            store.importFiles([URL(fileURLWithPath: "/fixture/ignored.txt")])
        }
        XCTAssertEqual(calls.filter { $0.first != "list" }, [["import", "/fixture/report.pdf"]])
        XCTAssertFalse(store.isBusy)
        XCTAssertNil(store.error)
    }

    func testFailedDraftDelegateDoesNotUseIndependentClientOrCallDidAttach() async {
        let recipient = WidgetSession(
            key: "chosen", target: WidgetTarget(hostId: "local", provider: "codex", sessionId: "chosen", sourceHome: "/fixture/home", cwd: "/fixture/project"),
            title: "Fixture", project: "Fixture", activityAt: 0, status: "recent", pinned: false, visible: true, hiddenByFilter: false
        )
        var calls: [[String]] = []
        var callbacks = 0
        let store = WidgetShelfStore(request: { args, _ in calls.append(args); return self.empty },
                                    didAttach: { _ in callbacks += 1 },
                                    attachToDraft: { _, _ in throw ToolsBridgeError.refused("Could not save fixture draft") })
        await complete(store) { store.attach(item, to: recipient) }
        XCTAssertFalse(calls.contains { $0.first == "attach" })
        XCTAssertEqual(callbacks, 0)
        XCTAssertTrue(store.error?.contains("Could not save fixture draft") == true)
        XCTAssertNil(store.notice)
    }

    func testCaptureCancelledBeforeItStartsReleasesTheShelf() async {
        var captures = 0
        let store = WidgetShelfStore(request: { args, _ in
            if args.first == "capture" { captures += 1 }
            return self.empty
        })
        await complete(store) {
            store.capture()
            store.cancelCapture()
        }
        XCTAssertEqual(captures, 0)
        XCTAssertFalse(store.isBusy)
        XCTAssertFalse(store.isCapturing)
        XCTAssertEqual(store.notice, "Capture cancelled.")
    }

    func testWebURLCannotBeMistakenForALocalFilePath() {
        var calls = 0
        let store = WidgetShelfStore(request: { _, _ in
            calls += 1
            return self.empty
        })
        store.importFiles([URL(string: "https://example.com/etc/hosts")!])
        XCTAssertEqual(calls, 0)
        XCTAssertFalse(store.isBusy)
        XCTAssertEqual(store.error, "Only local files can be staged.")
    }

    func testFailedImportContinuesOtherFilesAndReleasesOwnerForRetry() async {
        var imports: [String] = []
        let store = WidgetShelfStore(request: { args, _ in
            if args.first == "import" {
                imports.append(args[1])
                if args[1].hasSuffix("missing") { throw ToolsBridgeError.refused("Missing fixture") }
            }
            return self.empty
        })
        await complete(store) {
            store.importFiles([URL(fileURLWithPath: "/fixture/missing"), URL(fileURLWithPath: "/fixture/good")])
        }
        XCTAssertEqual(imports, ["/fixture/missing", "/fixture/good"])
        XCTAssertTrue(store.error?.contains("Missing fixture") == true)
        await complete(store) { store.importFiles([URL(fileURLWithPath: "/fixture/retry")]) }
        XCTAssertEqual(imports.last, "/fixture/retry")
        XCTAssertNil(store.error)
    }

    func testCancelThenRestartCaptureAndHideDoesNotCancelAnActiveSelection() async {
        let began = expectation(description: "Capture begins")
        let cancelled = expectation(description: "Capture releases owner")
        var captures = 0
        var prepareCount = 0
        let store = WidgetShelfStore(request: { args, _ in
            if args.first == "capture" {
                captures += 1
                if captures == 1 {
                    began.fulfill()
                    try await Task.sleep(for: .seconds(30))
                }
                return Data(#"{"id":"fixture-capture","kind":"capture","name":"Screenshot.png","path":"/fixture/capture.png","sha256":"hash","bytes":1,"createdAt":1,"assetId":"fixture-image"}"#.utf8)
            }
            return self.empty
        }, onCaptureWillBegin: { prepareCount += 1 })
        let subscription = store.$isBusy.dropFirst().filter { !$0 }.prefix(1).sink { _ in cancelled.fulfill() }
        store.capture()
        await fulfillment(of: [began], timeout: 2)
        store.visibilityChanged(module: "capture", presentation: nil)
        XCTAssertTrue(store.isCapturing)
        store.cancelCapture()
        await fulfillment(of: [cancelled], timeout: 2)
        XCTAssertFalse(store.isCapturing)
        XCTAssertNil(store.error)
        XCTAssertEqual(store.notice, "Capture cancelled.")
        await complete(store) { store.capture() }
        XCTAssertEqual(captures, 2)
        XCTAssertEqual(prepareCount, 2)
        withExtendedLifetime(subscription) {}
    }

    func testSuccessfulEmptyCaptureShowsNeutralCancellationWithoutPermissionWarning() async {
        let store = WidgetShelfStore(request: { args, _ in
            args.first == "capture" ? Data(#"{"cancelled":true}"#.utf8) : self.empty
        }, screenCaptureAccess: { false })
        await complete(store) { store.capture() }
        XCTAssertEqual(store.notice, "Capture cancelled.")
        XCTAssertNil(store.error)
        XCTAssertEqual(store.captureAccessGranted, false)
    }

    func testCaptureFailureReportsAppCapabilityWithoutClaimingCancellation() async {
        let store = WidgetShelfStore(request: { args, _ in
            if args.first == "capture" { throw ToolsBridgeError.refused("could not create image from window") }
            return self.empty
        }, screenCaptureAccess: { false })
        await complete(store) { store.capture() }
        XCTAssertTrue(store.error?.contains("could not create image from window") == true)
        XCTAssertTrue(store.error?.contains("System Settings") == true)
        XCTAssertNil(store.notice)
    }

    func testMalformedCaptureResponseCannotClaimAnImageWasStaged() async {
        let store = WidgetShelfStore(request: { args, _ in args.first == "capture" ? Data("{}".utf8) : self.empty })
        await complete(store) { store.capture() }
        XCTAssertNotNil(store.error)
        XCTAssertNil(store.notice)
    }

    func testCoordinatorStopCancelsCaptureWithoutRestartingRefreshOrPublishingLateState() async {
        let began = expectation(description: "Capture begins")
        let ended = expectation(description: "Capture task cancelled")
        var calls: [[String]] = []
        let store = WidgetShelfStore(request: { args, _ in
            calls.append(args)
            began.fulfill()
            defer { ended.fulfill() }
            try await Task.sleep(for: .seconds(30))
            return self.empty
        })
        store.capture()
        await fulfillment(of: [began], timeout: 2)
        store.stop()
        store.stop()
        store.refresh()
        store.capture()
        await fulfillment(of: [ended], timeout: 2)
        XCTAssertEqual(calls, [["capture"]])
        XCTAssertFalse(store.isBusy)
        XCTAssertFalse(store.isCapturing)
        XCTAssertNil(store.error)
        XCTAssertNil(store.notice)
    }

    func testAttachUsesExplicitRecipientAndOnlyReportsSuccessAfterMutation() async {
        let recipient = WidgetSession(
            key: "chosen-recipient", target: WidgetTarget(hostId: "local", provider: "codex", sessionId: "chosen", sourceHome: "/fixture/home", cwd: "/fixture/project"),
            title: "Fixture inbox", project: "Fixture", activityAt: 0, status: "recent",
            pinned: false, visible: true, hiddenByFilter: false
        )
        var attached: [String] = []
        var calls: [[String]] = []
        let store = WidgetShelfStore(request: { args, _ in
            calls.append(args)
            return self.empty
        }, didAttach: { attached.append($0.key) })
        await complete(store) { store.attach(item, to: recipient) }
        XCTAssertEqual(calls.first, ["attach", item.id, "--session-key", "chosen-recipient"])
        XCTAssertEqual(attached, ["chosen-recipient"])
        XCTAssertTrue(store.notice?.contains("Nothing has been sent") == true)
    }
}

@MainActor
private final class ShelfDraftBackend {
    var drafts: [String: WidgetDraft] = [:]
    var calls: [String] = []
    var reference: String? = "File: notes.pdf\nLocal path: /fixture/notes.pdf"
    var assetId: String?
    var resolve: (() async throws -> Void)?
    var beforeSave: (() async throws -> Void)?
    var textSaved: (() -> Void)?
    var beforeAppend: (() async throws -> Void)?
    var beforeTextSave: (() async throws -> Void)?

    func run(_ value: WidgetJSON) async throws -> WidgetJSON {
        guard case .object(let fields) = value, case .string(let action) = fields["action"] else {
            throw ToolsBridgeError.refused("Invalid fixture request")
        }
        calls.append(action)
        let key: String
        if case .string(let value) = fields["key"] { key = value } else { key = "" }
        switch action {
        case "shelf-attachment":
            try await resolve?()
            return try .value(WidgetShelfAttachment(
                mode: assetId == nil ? "file-reference" : "image", reference: reference, assetId: assetId,
                draft: drafts[key] ?? WidgetDraft()
            ))
        case "draft":
            try await beforeSave?()
            drafts[key] = try JSONDecoder().decode(WidgetDraft.self, from: JSONEncoder().encode(fields["draft"]))
        case "append-draft":
            try await beforeAppend?()
            var draft = drafts[key] ?? WidgetDraft()
            if case .string(let text) = fields["text"] {
                draft.text = [draft.text, text].filter { !$0.isEmpty }.joined(separator: " ")
            }
            drafts[key] = draft
            return try .value(draft)
        case "draft-text":
            try await beforeTextSave?()
            if case .string(let text) = fields["text"] {
                var draft = drafts[key] ?? WidgetDraft()
                draft.text = text
                drafts[key] = draft
                textSaved?()
            }
        default: break
        }
        return ["ok": .bool(true)]
    }
}

@MainActor
private final class ShelfDraftGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var deadline: Task<Void, Never>?

    func wait(timeout: Duration) async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            deadline = Task { [weak self] in
                do { try await Task.sleep(for: timeout) }
                catch is CancellationError { return }
                catch { XCTFail("Gate deadline failed: \(error)"); return }
                guard let self, self.continuation != nil else { return }
                XCTFail("Shelf draft gate was not released before its deadline")
                self.open()
            }
        }
    }

    func open() {
        deadline?.cancel()
        deadline = nil
        let pending = continuation
        continuation = nil
        pending?.resume()
    }
}

@MainActor
final class WidgetVoiceDraftOrderingTests: XCTestCase {
    private func model(_ backend: ShelfDraftBackend) -> WidgetModel {
        let defaults = UserDefaults(suiteName: "voice-attach-\(UUID().uuidString)")!
        let appearance = NativeSettingsAppearance(defaults: defaults, notificationNamespace: "voice.fixture.\(UUID())", observeExternalChanges: false)
        let model = WidgetModel(binaryPath: "/fixture/no-process", defaults: defaults, appearance: appearance)
        model.actionRunner = backend.run
        return model
    }
    private func note() throws -> WidgetVoiceNote {
        try JSONDecoder().decode(WidgetVoiceNote.self, from: Data(#"{"id":"note-fixture","revision":1,"createdAt":1,"clip":{"path":"/fixture/audio.pcm","bytes":3200,"durationMs":100},"text":"Voice words","recognizedText":"Voice words","transcription":"ready"}"#.utf8))
    }
    private func barrier(_ model: WidgetModel) async {
        let saved = expectation(description: "queue drained")
        model.action(["action": "fixture-barrier"], completed: { saved.fulfill() })
        await fulfillment(of: [saved], timeout: 2)
    }
    func testHostVoiceActionOpensNotesWithoutStartingLegacyListener() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("voice-routing-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let binary = root.appendingPathComponent("tools")
        let marker = root.appendingPathComponent("voice-invoked")
        let snapshot = #"{"version":1,"state":{"version":1,"revision":0,"preferences":{"excludedKeys":[],"projects":[],"sessions":[],"showChanges":true,"placement":"both","side":"right","quietSeconds":15,"voiceProvider":"fixture","voiceLanguage":"en"},"assets":{},"drafts":{},"outgoing":[]},"sessions":[],"cards":[],"manifests":{},"errors":[]}"#
        try "#!/bin/sh\nif [ \"$1\" = voice ]; then echo \"$*\" > '\(marker.path)'; exit 0; fi\nprintf '%s\\n' '\(snapshot)'\n".write(to: binary, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
        let defaults = UserDefaults(suiteName: "voice-routing-\(UUID())")!
        let model = WidgetModel(binaryPath: binary.path, stateRoot: root.path, defaults: defaults)
        defer { model.stop() }
        let loaded = expectation(description: "snapshot loaded")
        let subscription = model.$snapshot.compactMap { $0 }.prefix(1).sink { _ in loaded.fulfill() }
        model.startSettings()
        await fulfillment(of: [loaded], timeout: 3)
        model.selectedKey = "pinned-recipient"
        var requested: [String] = []
        model.recordVoiceNote = { requested.append($0) }
        model.toggleVoice()
        XCTAssertEqual(requested, ["pinned-recipient"])
        XCTAssertEqual(model.voiceActionLabel, "Record voice note")
        XCTAssertFalse(model.voiceActive)
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
        // Control: the same model and executable can still reach the standalone legacy listener.
        model.recordVoiceNote = nil
        let finished = expectation(description: "legacy fixture exits")
        let voiceSubscription = model.$voiceActive.dropFirst().filter { !$0 }.prefix(1).sink { _ in finished.fulfill() }
        model.toggleVoice()
        await fulfillment(of: [finished], timeout: 3)
        XCTAssertTrue(try String(contentsOf: marker, encoding: .utf8).contains("voice listen"))
        withExtendedLifetime((subscription, voiceSubscription)) {}
    }

    func testCoordinatorRegistersModulesAndSettingsOverInjectedRuntimeWithoutStartingIt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("voice-host-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let runtime = FlowFocusRuntime(dataRoot: directory, hostID: "fixture.preview", liveServices: false,
            presentsWindows: false, sharedModels: false)
        let coordinator = WidgetCoordinator(binaryPath: "/fixture/no-process", stateRoot: directory.path,
            flowRuntime: runtime, micLauncher: "/fixture/Preview", openHub: { _ in })
        XCTAssertTrue(coordinator.flowRuntime === runtime)
        XCTAssertEqual(runtime.role, .stopped)
        XCTAssertNotNil(coordinator.modules.module("focus"))
        XCTAssertNotNil(coordinator.modules.module("voice"))
        let sections = WidgetFeatureSettings.sections(model: coordinator.model, modules: WidgetModuleChoice.builtins,
            flowRuntime: runtime, transforms: coordinator.transforms, openSession: { _ in })
        let ids = sections.flatMap(\.pages).map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count)
        XCTAssertTrue(ids.contains("dictation.voice"))
        XCTAssertTrue(ids.contains("dictation.flow"))
        XCTAssertTrue(ids.contains("dictation.transforms"))
        XCTAssertTrue(ids.contains("focus.general"))
        await coordinator.shutdown()
        await coordinator.shutdown()
        XCTAssertEqual(runtime.role, .stopped)
    }

    func testExplicitAttachPreservesDirtyTextFilesAndNonselectedRecipient() async throws {
        let backend = ShelfDraftBackend()
        backend.drafts["chosen"] = WidgetDraft(text: "Old", assetIds: ["existing-file"])
        let model = model(backend)
        defer { model.stop() }
        model.selectedKey = "chosen"
        model.setText("Fresh")
        model.selectedKey = "another"
        try await model.attachVoiceNote(note(), to: "chosen")
        XCTAssertEqual(backend.drafts["chosen"]?.text, "Fresh Voice words")
        XCTAssertEqual(backend.drafts["chosen"]?.assetIds, ["existing-file"])
        XCTAssertEqual(model.drafts["chosen"], backend.drafts["chosen"])
        XCTAssertNil(backend.drafts["another"])
        XCTAssertEqual(model.selectedKey, "another")
        XCTAssertFalse(backend.calls.contains("enqueue"))
    }
    func testTypingDuringAppendIsMergedAndLaterTypingWinsFinalSave() async throws {
        let backend = ShelfDraftBackend()
        backend.drafts["chosen"] = WidgetDraft(text: "Initial", assetIds: ["image"])
        let appendStarted = expectation(description: "append")
        let gate = ShelfDraftGate()
        backend.beforeAppend = { appendStarted.fulfill(); await gate.wait() }
        let model = model(backend)
        defer { model.stop() }
        model.selectedKey = "chosen"
        let attachment = Task { try await model.attachVoiceNote(self.note(), to: "chosen") }
        await fulfillment(of: [appendStarted], timeout: 2)
        model.setText("Typed during append")
        gate.open()
        try await attachment.value
        XCTAssertEqual(model.drafts["chosen"]?.text, "Typed during append Voice words")
        XCTAssertEqual(backend.drafts["chosen"]?.text, "Typed during append Voice words")
        XCTAssertEqual(backend.drafts["chosen"]?.assetIds, ["image"])
    }
    func testTypingDuringInitialFlushIsNotLost() async throws {
        let backend = ShelfDraftBackend()
        let flushStarted = expectation(description: "initial flush")
        let gate = ShelfDraftGate()
        var writes = 0
        backend.beforeTextSave = { writes += 1; if writes == 1 { flushStarted.fulfill(); await gate.wait() } }
        let model = model(backend)
        defer { model.stop() }
        model.selectedKey = "chosen"
        model.setText("First")
        let attachment = Task { try await model.attachVoiceNote(self.note(), to: "chosen") }
        await fulfillment(of: [flushStarted], timeout: 2)
        model.setText("New typing")
        gate.open()
        try await attachment.value
        XCTAssertEqual(backend.drafts["chosen"]?.text, "New typing Voice words")
    }
    func testTypingDuringFinalSaveRemainsQueuedAfterAttachment() async throws {
        let backend = ShelfDraftBackend()
        backend.drafts["chosen"] = WidgetDraft(text: "Initial", assetIds: ["file"])
        let saving = expectation(description: "final save")
        let gate = ShelfDraftGate()
        var writes = 0
        backend.beforeTextSave = { writes += 1; if writes == 1 { saving.fulfill(); await gate.wait() } }
        let model = model(backend)
        defer { model.stop() }
        model.selectedKey = "chosen"
        let attachment = Task { try await model.attachVoiceNote(self.note(), to: "chosen") }
        await fulfillment(of: [saving], timeout: 2)
        model.setText("Reviewed after attachment")
        model.action(["action": "draft-text", "key": "chosen", "text": "Reviewed after attachment"])
        gate.open()
        try await attachment.value
        await barrier(model)
        XCTAssertEqual(backend.drafts["chosen"]?.text, "Reviewed after attachment")
        XCTAssertEqual(model.drafts["chosen"]?.text, "Reviewed after attachment")
        XCTAssertEqual(backend.drafts["chosen"]?.assetIds, ["file"])
    }
    func testCancellationBeforeAppendDoesNotSendOrAppendText() async throws {
        let backend = ShelfDraftBackend()
        backend.drafts["chosen"] = WidgetDraft(text: "Keep", assetIds: ["file"])
        let began = expectation(description: "append begins")
        backend.beforeAppend = { began.fulfill(); try await Task.sleep(for: .seconds(30)) }
        let model = model(backend)
        defer { model.stop() }
        let attachment = Task { try await model.attachVoiceNote(self.note(), to: "chosen") }
        await fulfillment(of: [began], timeout: 2)
        attachment.cancel()
        do { try await attachment.value; XCTFail("must cancel") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(backend.drafts["chosen"]?.text, "Keep")
        XCTAssertFalse(backend.calls.contains("enqueue"))
    }
}

@MainActor
final class WidgetShelfDraftOrderingTests: XCTestCase {
    private func model(_ backend: ShelfDraftBackend) -> WidgetModel {
        let defaults = UserDefaults(suiteName: "widget-shelf-test-\(UUID().uuidString)")!
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("widget-shelf-model-\(UUID().uuidString)")
        let appearance = NativeSettingsAppearance(defaults: defaults, notificationNamespace: "fixture.shelf.\(UUID().uuidString)", observeExternalChanges: false)
        let model = WidgetModel(binaryPath: "/fixture/no-process", stateRoot: root.path, defaults: defaults, appearance: appearance)
        model.actionRunner = backend.run
        return model
    }

    private func barrier(_ model: WidgetModel) async {
        let done = expectation(description: "Mutation queue drained")
        model.action(["action": "fixture-barrier"], completed: { done.fulfill() })
        await fulfillment(of: [done], timeout: 2)
    }

    func testTypingThenSwitchingRecipientKeepsTextAndStagesOnlyIntoChosenDraft() async throws {
        let backend = ShelfDraftBackend()
        backend.drafts["chosen"] = WidgetDraft(text: "Older persisted text")
        let model = model(backend)
        defer { model.stop() }
        model.selectedKey = "chosen"
        model.setText("Typed just before switching")
        model.selectedKey = "another"
        try await model.attachShelfItem("file", to: "chosen")
        await barrier(model)
        let expected = "Typed just before switching\n\n" + backend.reference!
        XCTAssertEqual(model.drafts["chosen"]?.text, expected)
        XCTAssertEqual(backend.drafts["chosen"]?.text, expected)
        XCTAssertNil(model.drafts["another"])
        XCTAssertEqual(model.selectedKey, "another")
        XCTAssertFalse(backend.calls.contains("draft-text"))
    }

    func testTypingDuringDescriptorResolutionInvalidatesAlreadyQueuedStaleTextSave() async throws {
        let began = expectation(description: "Descriptor read begins")
        let gate = ShelfDraftGate()
        let backend = ShelfDraftBackend()
        backend.resolve = { began.fulfill(); await gate.wait(timeout: .seconds(5)) }
        let model = model(backend)
        defer { model.stop() }
        model.selectedKey = "chosen"
        model.setText("Before")
        let attachment = Task { try await model.attachShelfItem("file", to: "chosen") }
        await fulfillment(of: [began], timeout: 2)
        model.setText("Typed while resolving")
        model.action(["action": "draft-text", "key": "chosen", "text": "Typed while resolving"])
        gate.open()
        try await attachment.value
        await barrier(model)
        let expected = "Typed while resolving\n\n" + backend.reference!
        XCTAssertEqual(model.drafts["chosen"]?.text, expected)
        XCTAssertEqual(backend.drafts["chosen"]?.text, expected)
        XCTAssertFalse(backend.calls.contains("draft-text"))
    }

    func testTypingDuringDelayedDraftSavePersistsNewerTextWithAttachment() async throws {
        let began = expectation(description: "Draft write begins")
        let laterText = expectation(description: "Actual debounce saves newer text")
        let gate = ShelfDraftGate()
        let backend = ShelfDraftBackend()
        backend.beforeSave = { began.fulfill(); await gate.wait(timeout: .seconds(5)) }
        backend.textSaved = { laterText.fulfill() }
        let model = model(backend)
        defer { model.stop() }
        model.selectedKey = "chosen"
        model.setText("Before")
        let attachment = Task { try await model.attachShelfItem("file", to: "chosen") }
        await fulfillment(of: [began], timeout: 2)
        let edited = "Edited while saving\n\n" + backend.reference!
        model.setText(edited)
        gate.open()
        try await attachment.value
        await fulfillment(of: [laterText], timeout: 2)
        XCTAssertEqual(model.drafts["chosen"]?.text, edited)
        XCTAssertEqual(backend.drafts["chosen"]?.text, edited)
    }

    func testImageAttachmentPreservesExistingIDsAndIsIdempotentForNonselectedRecipient() async throws {
        let backend = ShelfDraftBackend()
        backend.reference = nil
        backend.assetId = "new-image"
        backend.drafts["chosen"] = WidgetDraft(text: "Existing draft", assetIds: ["old-image"])
        let model = model(backend)
        defer { model.stop() }
        model.selectedKey = "another"
        try await model.attachShelfItem("image", to: "chosen")
        try await model.attachShelfItem("image", to: "chosen")
        XCTAssertEqual(model.drafts["chosen"]?.assetIds, ["old-image", "new-image"])
        XCTAssertEqual(backend.drafts["chosen"]?.assetIds, ["old-image", "new-image"])
        XCTAssertEqual(model.drafts["chosen"]?.text, "Existing draft")
        XCTAssertEqual(model.selectedKey, "another")
        XCTAssertNil(backend.drafts["another"])
    }

    func testResolutionFailureLeavesLocalDraftUntouchedAndSaveFailureRetainsRecoverableMerge() async {
        let backend = ShelfDraftBackend()
        let model = model(backend)
        defer { model.stop() }
        model.selectedKey = "chosen"
        model.setText("Keep this text")
        backend.resolve = { throw ToolsBridgeError.refused("Missing managed item") }
        do {
            try await model.attachShelfItem("file", to: "chosen")
            XCTFail("Expected resolution failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Missing managed item")) }
        XCTAssertEqual(model.drafts["chosen"]?.text, "Keep this text")
        XCTAssertNil(backend.drafts["chosen"])
        backend.resolve = nil
        backend.beforeSave = { throw ToolsBridgeError.refused("Disk fixture full") }
        do {
            try await model.attachShelfItem("file", to: "chosen")
            XCTFail("Expected persistence failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Disk fixture full")) }
        XCTAssertEqual(model.drafts["chosen"]?.text, "Keep this text\n\n" + backend.reference!)
        XCTAssertNil(backend.drafts["chosen"])
        backend.beforeSave = nil
        do { try await model.attachShelfItem("file", to: "chosen") }
        catch { XCTFail("Retry failed: \(error)") }
        XCTAssertEqual(backend.drafts["chosen"]?.text, model.drafts["chosen"]?.text)
    }

    func testDirtyLocalTextCannotEraseDurableImageIDsThatHaveNotReachedTheSnapshot() async throws {
        let backend = ShelfDraftBackend()
        backend.assetId = "new-image"
        backend.reference = nil
        backend.drafts["chosen"] = WidgetDraft(text: "Persisted", assetIds: ["existing-image"])
        let model = model(backend)
        defer { model.stop() }
        model.selectedKey = "chosen"
        model.setText("Fresh local text")
        XCTAssertEqual(model.drafts["chosen"]?.assetIds, [])
        try await model.attachShelfItem("image", to: "chosen")
        XCTAssertEqual(backend.drafts["chosen"]?.assetIds, ["existing-image", "new-image"])
        XCTAssertEqual(backend.drafts["chosen"]?.text, "Fresh local text")
    }

    func testCancellationDuringSaveKeepsRecoverableLocalDraftWithoutClaimingSuccess() async {
        let began = expectation(description: "Draft write begins")
        let backend = ShelfDraftBackend()
        backend.beforeSave = { began.fulfill(); try await Task.sleep(for: .seconds(30)) }
        let model = model(backend)
        defer { model.stop() }
        model.selectedKey = "chosen"
        model.setText("Keep this text")
        let attachment = Task { try await model.attachShelfItem("file", to: "chosen") }
        await fulfillment(of: [began], timeout: 2)
        attachment.cancel()
        do {
            try await attachment.value
            XCTFail("Expected cancellation")
        } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(model.drafts["chosen"]?.text, "Keep this text\n\n" + backend.reference!)
        XCTAssertNil(backend.drafts["chosen"])
    }

    func testCancellationBeforeMergeDoesNotChangeDraftOrIssueWrite() async {
        let began = expectation(description: "Descriptor read begins")
        let backend = ShelfDraftBackend()
        backend.resolve = { began.fulfill(); try await Task.sleep(for: .seconds(30)) }
        let model = model(backend)
        defer { model.stop() }
        let attachment = Task { try await model.attachShelfItem("file", to: "chosen") }
        await fulfillment(of: [began], timeout: 2)
        attachment.cancel()
        do {
            try await attachment.value
            XCTFail("Expected cancellation")
        } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertNil(model.drafts["chosen"])
        XCTAssertEqual(backend.calls, ["shelf-attachment"])
    }
}

@MainActor
final class WidgetTasksStoreTests: XCTestCase {
    private func task(state: String = "open", revision: Int = 1) -> WidgetTask {
        WidgetTask(id: "t_1_fixture", number: 1, title: "Run local checks", summary: "Run the project checks before publishing.",
                   truncated: false, revision: revision, state: state, updatedTs: "2026-01-01T10:00:00.000Z",
                   blocking: true, owner: "agent", sessionId: "fixture", provider: "codex", sessionTitle: "Fixture session",
                   sourceContext: WidgetSourceContext(sessionId: "fixture", agent: "codex", project: "Fixture", cwd: "/fixture/project"))
    }

    private func data(_ tasks: [WidgetTask] = [], sourcePath: String = "/fixture/tasks/decisions.jsonl") throws -> Data {
        try JSONEncoder().encode(WidgetTaskSnapshot(tasks: tasks, total: tasks.count,
            activeCount: tasks.filter { ["open", "acknowledged"].contains($0.state) }.count, truncated: false,
            sourcePath: sourcePath, sourceStamp: tasks.first?.state ?? "empty", projects: ["Fixture"],
            sessions: [.init(id: "codex:fixture", title: "Fixture session")]))
    }

    private func loaded(_ store: WidgetTasksStore, action: () -> Void) async {
        let finished = expectation(description: "Task metadata load finishes")
        let subscription = store.$isLoading.dropFirst().filter { !$0 }.prefix(1).sink { _ in finished.fulfill() }
        action()
        await fulfillment(of: [finished], timeout: 3)
        withExtendedLifetime(subscription) {}
    }

    private func mutated(_ store: WidgetTasksStore, action: () -> Void) async {
        let finished = expectation(description: "Task mutation finishes")
        let subscription = store.$mutatingID.dropFirst().filter { $0 == nil }.prefix(1).sink { _ in finished.fulfill() }
        action()
        await fulfillment(of: [finished], timeout: 3)
        withExtendedLifetime(subscription) {}
        if store.isLoading { await loaded(store) {} }
    }

    func testDefaultMetadataAndWarmSurfacesReuseOneCacheWhileFiltersStayScoped() async throws {
        var calls: [[String]] = []
        let source = task()
        let store = WidgetTasksStore(request: { args in
            calls.append(args)
            return try self.data(args.contains("completed") ? [] : [source])
        })
        defer { store.stop() }
        await loaded(store) { store.visibilityChanged(.compact) }
        XCTAssertEqual(calls, [["list", "--json", "--scope", "active", "--limit", "200"]])
        XCTAssertEqual(store.tasks.first?.sourceContext.project, "Fixture")
        for _ in 0..<1000 {
            store.visibilityChanged(.preview)
            store.visibilityChanged(.expanded)
            _ = store.taskModule().summary()
        }
        XCTAssertEqual(calls.count, 1, "Warm surface changes must not spawn commands")
        await loaded(store) { store.scope = "completed" }
        XCTAssertTrue(store.tasks.isEmpty)
        XCTAssertEqual(calls.count, 2)
        store.scope = "active"
        XCTAssertEqual(store.tasks.first?.id, source.id)
        XCTAssertEqual(calls.count, 2, "Returning to a cached filter is immediate")
        await loaded(store) { store.project = "Other" }
        XCTAssertTrue(calls.last?.contains("--project") == true)
        XCTAssertTrue(calls.last?.contains("Other") == true)
        await loaded(store) { store.session = "codex:fixture" }
        XCTAssertTrue(calls.last?.contains("codex:fixture") == true)
        await loaded(store) { store.sourceChanged() }
        XCTAssertEqual(calls.count, 5, "An event invalidates cached metadata")
    }

    func testReadFailureIsExplicitAndRetryRecoversWithoutInventedTasks() async throws {
        var fails = true
        let store = WidgetTasksStore(request: { _ in
            if fails { throw ToolsBridgeError.refused("Fixture ledger unavailable") }
            return try self.data()
        })
        defer { store.stop() }
        await loaded(store) { store.refresh() }
        XCTAssertTrue(store.tasks.isEmpty)
        XCTAssertTrue(store.error?.contains("unavailable") == true)
        fails = false
        await loaded(store) { store.refresh(force: true) }
        XCTAssertNil(store.error)
        XCTAssertTrue(store.tasks.isEmpty)
    }

    func testMutationCarriesExactGuardsAndRequiresASavedReceipt() async throws {
        let original = task()
        var changed = original
        changed.state = "implemented"
        changed.updatedTs = "2026-01-01T10:00:00.001Z"
        var calls: [[String]] = []
        let store = WidgetTasksStore(request: { args in
            calls.append(args)
            if args.first == "update" {
                return try JSONEncoder().encode(WidgetTaskUpdate(task: changed, receipt: .init(
                    id: original.id, action: "complete", from: "open", state: "implemented", revision: 1,
                    at: changed.updatedTs, saved: true)))
            }
            return try self.data()
        })
        defer { store.stop() }
        await mutated(store) {
            store.perform(.complete, on: original)
            store.perform(.dismiss, on: original)
        }
        XCTAssertEqual(calls.filter { $0.first == "update" }, [["update", original.id, "--action", "complete",
            "--revision", "1", "--state", "open", "--updated-at", original.updatedTs, "--session", "fixture", "--provider", "codex"]])
        XCTAssertTrue(store.receipt?.contains("Completed") == true)
        XCTAssertNil(store.error)
        XCTAssertTrue(store.tasks.isEmpty)
    }

    func testStaleFailureRemainsVisibleAfterReloadAndCannotClaimCompletion() async throws {
        let original = task()
        let store = WidgetTasksStore(request: { args in
            if args.first == "update" { throw ToolsBridgeError.refused("Task changed since it was shown") }
            return try self.data([self.task(revision: 2)])
        })
        defer { store.stop() }
        await mutated(store) { store.perform(.complete, on: original) }
        XCTAssertTrue(store.error?.contains("changed") == true)
        XCTAssertNil(store.receipt)
        XCTAssertEqual(store.tasks.first?.revision, 2)
    }

    func testCancellationRefreshesActualStateWithoutClaimingThatNothingWasSaved() async throws {
        let started = expectation(description: "Update starts")
        let store = WidgetTasksStore(request: { args in
            if args.first == "update" {
                started.fulfill()
                try await Task.sleep(for: .seconds(30))
            }
            return try self.data()
        })
        defer { store.stop() }
        store.perform(.complete, on: task())
        await fulfillment(of: [started], timeout: 2)
        await mutated(store) { store.cancelUpdate() }
        XCTAssertNil(store.receipt)
        XCTAssertTrue(store.error?.contains("Refreshing") == true)
        XCTAssertFalse(store.isMutating)
    }

    func testDirectoryEventsNormalizeOnlySystemAliasesBeforeFiltering() {
        XCTAssertEqual(DirectoryWatcher.normalizedEventPath("/private/var/folders/fixture/decisions.jsonl"), "/var/folders/fixture/decisions.jsonl")
        XCTAssertEqual(DirectoryWatcher.normalizedEventPath("/private/tmp/fixture/state.json"), "/tmp/fixture/state.json")
        XCTAssertEqual(DirectoryWatcher.normalizedEventPath("/Users/fixture/decisions.jsonl"), "/Users/fixture/decisions.jsonl")
        XCTAssertEqual(DirectoryWatcher.normalizedEventPath("/private/variable/file"), "/private/variable/file")
        XCTAssertEqual(DirectoryWatcher.normalizedEventPath("/private/tmp-other/file"), "/private/tmp-other/file")
    }

    func testARealLedgerFileEventRefreshesVisibleMetadataWithoutPolling() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("widget-tasks-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            do { try FileManager.default.removeItem(at: directory) } catch { XCTFail("Fixture cleanup: \(error)") }
        }
        let file = directory.appendingPathComponent("decisions.jsonl")
        try "1".write(to: file, atomically: true, encoding: .utf8)
        var calls = 0
        let store = WidgetTasksStore(request: { _ in
            calls += 1
            let revision = Int(try String(contentsOf: file, encoding: .utf8)) ?? 0
            return try self.data([self.task(revision: revision)], sourcePath: file.path)
        })
        defer { store.stop() }
        await loaded(store) { store.visibilityChanged(.expanded) }
        let changed = expectation(description: "FSEvents refreshes changed ledger")

        let subscription = store.$snapshot.compactMap { $0?.tasks.first?.revision }.filter { $0 == 2 }.prefix(1)
            .sink { _ in changed.fulfill() }
        try "2".write(to: file, atomically: true, encoding: .utf8)
        await fulfillment(of: [changed], timeout: 3)
        withExtendedLifetime(subscription) {}
        XCTAssertGreaterThanOrEqual(calls, 2)
        XCTAssertEqual(store.tasks.first?.revision, 2)
    }

    func testSourceSessionMatchingIsProviderSpecificAndStopCancelsPendingWork() async throws {
        let codex = WidgetSession(key: "codex", target: .init(hostId: "local", provider: "codex", sessionId: "fixture", sourceHome: "", cwd: "/fixture"),
                                  title: "Fixture", project: "Fixture", activityAt: 0, status: "recent", pinned: true, visible: true, hiddenByFilter: false)
        var grok = codex
        grok.key = "grok"
        grok.target.provider = "grok"
        let started = expectation(description: "Read starts")
        let cancelled = expectation(description: "Read cancellation reaches request")
        var opened: [String] = []
        let store = WidgetTasksStore(request: { _ in
            started.fulfill()
            defer { cancelled.fulfill() }
            try await Task.sleep(for: .seconds(30))
            return try self.data([self.task()])
        }, sessions: { [grok, codex] }, openSession: { session, card in opened.append(session.key + ":" + card) })
        XCTAssertEqual(store.sourceSession(for: task())?.key, "codex")
        store.openSource(task())
        XCTAssertEqual(opened, ["codex:decision:t_1_fixture"])
        store.refresh()
        await fulfillment(of: [started], timeout: 2)
        store.stop()
        await fulfillment(of: [cancelled], timeout: 2)
        XCTAssertFalse(store.isLoading)
        XCTAssertTrue(store.tasks.isEmpty)
        XCTAssertNil(store.error)
    }
}

@MainActor
final class WidgetInboxNotificationTests: XCTestCase {
    private let key = "local:codex:fixture-new:"
    private func model() -> WidgetModel {
        let defaults = UserDefaults(suiteName: "widget.inbox.fixture." + UUID().uuidString)!
        let appearance = NativeSettingsAppearance(defaults: defaults,
            notificationNamespace: "inbox.fixture." + UUID().uuidString, observeExternalChanges: false)
        return WidgetModel(binaryPath: "/fixture/tools", stateRoot: FileManager.default.temporaryDirectory.path,
                           defaults: defaults, appearance: appearance)
    }
    private func item(_ id: String, at: Double, pending: Bool = false) -> WidgetInboxItem {
        WidgetInboxItem(id: (pending ? "form:" : "answer:") + id, sourceId: id,
                        kind: pending ? "form" : "answer", key: key, at: at, needsAnswer: pending)
    }
    private func summary(_ item: WidgetInboxItem) -> WidgetInboxSummary {
        WidgetInboxSummary(unread: item.needsAnswer ? 0 : 1, needsAnswer: item.needsAnswer ? 1 : 0,
            complete: true, truncated: false, sessions: [WidgetInboxSession(key: key,
                unread: item.needsAnswer ? 0 : 1, needsAnswer: item.needsAnswer ? 1 : 0, latest: item,
                unreadItem: item.needsAnswer ? nil : item, pendingItem: item.needsAnswer ? item : nil)])
    }
    private func snapshot(_ notification: WidgetInboxItem, cardID: String?, selected: String) throws -> String {
        let old = "local:codex:fixture-old:"
        let sessions: [[String: Any]] = [old, key].map { value in
            ["key": value, "target": ["hostId": "local", "provider": "codex", "sessionId": value == key ? "fixture-new" : "fixture-old",
                "sourceHome": "", "cwd": "/fixture"], "title": "Fixture", "project": "Fixture", "activityAt": 0,
             "status": notification.needsAnswer ? "waiting" : "recent", "pinned": true, "visible": true, "hiddenByFilter": false]
        }
        let cards: [[String: Any]] = cardID.map { id in [["id": id, "kind": notification.kind,
            "sourceId": notification.sourceId, "sessionKey": selected, "at": notification.at, "title": "Fixture",
            "body": "Receipt", "status": notification.needsAnswer ? "pending" : "answered", "choices": [],
            "attachments": [], "refs": [], "read": false]] } ?? []
        let encoded = try JSONEncoder().encode(summary(notification))
        let notifications = try JSONSerialization.jsonObject(with: encoded)
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "state": ["version": 1, "revision": 0,
            "selectedKey": selected, "preferences": ["excludedKeys": [], "projects": [], "sessions": [], "showChanges": false,
                "placement": "both", "side": "right", "quietSeconds": 15, "voiceProvider": "openai", "voiceLanguage": "en"],
            "assets": [:], "drafts": [:], "outgoing": []], "sessions": sessions, "cards": cards,
            "manifests": [:], "errors": [], "selectedKey": selected, "notifications": notifications])
        return String(decoding: data, as: UTF8.self)
    }

    func testFirstSnapshotAndOlderUnreadFallbackDoNotReplayAttention() {
        let model = model()
        defer { model.stop() }
        let now = Date().timeIntervalSince1970 * 1000
        model.updateInbox(summary(item("old", at: now - 1000)))
        XCTAssertEqual(model.inboxCount, 1)
        XCTAssertEqual(model.inboxPulse, 0)
        let fresh = summary(item("fresh", at: now + 100_000))
        model.updateInbox(fresh)
        XCTAssertEqual(model.inboxPulse, 1)
        XCTAssertEqual(model.inboxPulseFor(key), 1)
        model.updateInbox(fresh)
        model.updateInbox(summary(item("older", at: now - 2000)))
        XCTAssertEqual(model.inboxPulse, 1)
        XCTAssertEqual(model.inboxCount, 1)
    }

    func testUnavailableThenFirstCompleteSnapshotDoesNotReplayHistoricalItems() {
        let model = model()
        defer { model.stop() }
        model.updateInbox(.empty)
        model.updateInbox(summary(item("historical", at: 1)))
        XCTAssertEqual(model.inboxPulse, 0)
        XCTAssertTrue(model.inbox.complete)
    }

    func testBadgeNavigationAcknowledgesOnlyTheMatchingOpenedReceipt() async throws {
        let model = model()
        defer { model.stop() }
        let old = "local:codex:fixture-old:"
        let notification = item("wanted", at: 1)
        model.selectedKey = old
        var reads: [WidgetJSON] = []
        let selected = expectation(description: "Selection saved")
        let read = expectation(description: "Visible matching receipt acknowledged")
        model.actionRunner = { value in
            if case .object(let fields) = value {
                if fields["action"] == .string("selection") { selected.fulfill() }
                if fields["action"] == .string("inbox-read") { reads.append(value); read.fulfill() }
            }
            return ["ok": true]
        }
        model.receive([try snapshot(notification, cardID: "answer:old", selected: old)])
        model.openInboxNotification(on: .init(edge: .top, group: 0), needsAnswer: false)
        await fulfillment(of: [selected], timeout: 2)
        XCTAssertEqual(model.selectedKey, key)
        XCTAssertEqual(model.selectedCardID, "answer:wanted")
        XCTAssertTrue(reads.isEmpty)
        model.receive([try snapshot(notification, cardID: "answer:unrelated", selected: key)])
        XCTAssertTrue(reads.isEmpty)
        model.receive([try snapshot(notification, cardID: "answer:wanted", selected: key)])
        await fulfillment(of: [read], timeout: 2)
        XCTAssertEqual(reads.count, 1)
        model.receive([try snapshot(notification, cardID: "answer:wanted", selected: key)])
        XCTAssertEqual(reads.count, 1)
    }

    func testReadingPendingQuestionKeepsNeedsAnswerAndCollapseCancelsLateAck() async throws {
        let model = model()
        defer { model.stop() }
        let notification = item("pending", at: 1, pending: true)
        model.selectedKey = key
        var reads = 0
        model.actionRunner = { value in
            if case .object(let fields) = value, fields["action"] == .string("inbox-read") { reads += 1 }
            return ["ok": true]
        }
        model.receive([try snapshot(notification, cardID: nil, selected: key)])
        model.openInboxNotification(on: .init(edge: .right, group: 0), needsAnswer: true)
        model.collapse()
        model.receive([try snapshot(notification, cardID: notification.id, selected: key)])
        await Task.yield()
        XCTAssertEqual(reads, 0)
        XCTAssertEqual(model.inbox.needsAnswer, 1)
    }
}
