import AppKit
import LocalAuthentication
import SwiftUI
import UniformTypeIdentifiers
import XCTest
@testable import GenesisToolsHost

/// The `tools rm approve` window (Sources/Host/RmApprove.swift) drawn from a fixture request into a borderless window
/// that is never ordered front (alpha 0, behind every window, no mouse), so a review gets a picture without a real
/// request and without taking anyone's focus. Touch ID is a fake evaluator: the sensor is never armed. Only when
/// `RM_APPROVE_SHOTS` names the folder and the file prefix to write (`<folder>/<prefix>`; each variant adds a suffix).
@MainActor
final class RmApproveShots: XCTestCase {
    /// Never starts the sensor. `failWith` answers the first touch with that error, `unavailable` says Touch ID is out.
    final class StillEvaluator: ApprovalBiometricEvaluator {
        var unavailable: String?
        var failWith: LAError.Code?

        func unavailableReason(_ context: LAContext) -> String? { unavailable }
        func evaluateBiometrics(_ context: LAContext, reason: String, reply: @escaping @Sendable (Bool, Error?) -> Void) {
            if let failWith { reply(false, LAError(failWith)) }
        }
        func evaluatePassword(reason: String, reply: @escaping @Sendable (Bool, Error?) -> Void) {}
    }

    private let home = "/Users/someone"
    private let base = "/Users/someone/Notes/Shop/shop-admin-2.0/Design/Administration"

    private let asker = RmApproveAsker(agent: "Claude Code", session: "shop-admin-2.0", project: "shop-web", branch: "develop")

    private func params(_ items: [RmApproveItem], cwd: String = "/Users/someone/Projects/shop-web", asker: RmApproveAsker? = nil) -> RmApproveParams {
        let asker = asker ?? self.asker
        // The title as the CLI sends it.
        let title = "Delete \(Plural.count(items.count, "item")) asked by \(RmWindowContent.askedBy(asker))?"
        return RmApproveParams(
            title: title, lines: [], caller: "Claude Code · shop-admin-2.0", folder: cwd,
            request: RmApproveRequest(
                id: "k7m2xq", kind: "delete", why: "The old exports are replaced by the new admin designs",
                cwd: cwd, graceMinutes: 60, asker: asker, items: items))
    }

    private var twoItems: [RmApproveItem] {
        [
            RmApproveItem(path: "\(base)/Dark 2", kind: "dir", bytes: 0, empty: true, storedAt: nil,
                          reason: "Outside this session's scratch, its own files and the trusted folders"),
            RmApproveItem(path: "\(base)/Export notes.md", kind: "file", bytes: 12_400, empty: nil, storedAt: nil,
                          reason: "Holds 3 files git does not track in ~/Notes, which may be new work"),
        ]
    }

    func testApprovalWindowShots() throws {
        guard let prefix = ProcessInfo.processInfo.environment["RM_APPROVE_SHOTS"] else {
            throw XCTSkip("pictures only when RM_APPROVE_SHOTS names a file prefix")
        }

        try shot(twoItems, StillEvaluator(), to: "\(prefix)-after.png")

        let failed = StillEvaluator()
        failed.failWith = .authenticationFailed
        var many = twoItems
        many += (1...5).map { index in
            RmApproveItem(path: "\(base)/Variant \(index).png", kind: "file", bytes: Int64(index) * 182_000, empty: nil,
                          storedAt: index == 2 ? "/tmp/cc/shop/aside/Variant 2.png" : nil, reason: "Outside this session's scratch, its own files and the trusted folders")
        }
        many.append(RmApproveItem(path: "\(base)/old-export.zip", kind: "missing", bytes: nil, empty: nil, storedAt: nil,
                                  reason: "Outside this session's scratch, its own files and the trusted folders"))
        try shot(many, failed, to: "\(prefix)-after-many-retry.png")

        let noTouchID = StillEvaluator()
        noTouchID.unavailable = "Touch ID is not available on this Mac. Use your password."
        try shot(Array(twoItems.prefix(1)), noTouchID, to: "\(prefix)-after-password.png")

        // Every chip and folders relative to the session's folder, in four rows so none is cut (the aside header is in
        // the many-retry shot).
        let cwd = "/Users/someone/Projects/ReservineBack"
        let rules = [
            RmApproveItem(path: "\(cwd)/ReservineBack", kind: "dir", bytes: 0, empty: true, storedAt: nil,
                          reason: "Outside this session's scratch, its own files and the trusted folders", rule: "default"),
            RmApproveItem(path: "\(cwd)/Design/Admin/Export notes.md", kind: "file", bytes: 12_400, empty: nil, storedAt: nil,
                          reason: "Changes git has not committed", rule: "git-tracked", git: RmApproveGit(state: "modified", repo: cwd)),
            RmApproveItem(path: "\(cwd)/apps/ReservineBack", kind: "dir", bytes: 2_400_000, empty: false, storedAt: nil,
                          reason: "Holds 1 git repository, e.g. apps/ReservineBack", rule: "nested-repos",
                          folderStats: RmApproveFolderStats(files: 318, newestAt: nil)),
            RmApproveItem(path: "/Users/someone/Notes/todo.md", kind: "file", bytes: 2_000, empty: nil, storedAt: nil,
                          reason: "Outside this session's scratch, its own files and the trusted folders", rule: "default"),
        ]
        let reservine = RmApproveAsker(agent: "Claude Code", session: "reservine-api", project: "ReservineBack")
        try shot(rules, StillEvaluator(), to: "\(prefix)-rules.png", params: params(rules, cwd: cwd, asker: reservine))

        // An agent opened the window itself: the sensor waits for the click.
        var click = params(twoItems)
        click.arm = "click"
        try shot(twoItems, StillEvaluator(), to: "\(prefix)-click.png", params: click)
    }

    private func shot(_ items: [RmApproveItem], _ evaluator: StillEvaluator, to path: String, params given: RmApproveParams? = nil) throws {
        let request = given ?? self.params(items)
        let content = RmWindowContent.build(request, home: home, icons: false, markdownApp: true)
        let shown = content.items.map { item in
            let raw = items.first { $0.path == item.path }
            return ApprovalItem(path: item.path, location: item.location, name: item.name, folder: item.folder, size: item.size,
                                reason: item.reason, gone: item.gone, aside: item.aside, isFolder: item.isFolder,
                                opensInMarkdown: item.opensInMarkdown,
                                icon: NSWorkspace.shared.icon(for: raw?.kind == "dir" ? .folder : (UTType(filenameExtension: (item.path as NSString).pathExtension) ?? .data)),
                                git: item.git, detail: item.detail, alsoIn: item.alsoIn, notes: item.notes, risk: item.risk)
        }
        let verifier = ApprovalVerifier(reason: "approve: fixture", evaluator: evaluator)
        let model = content.dialogModel(
            items: shown,
            rememberChoices: [ApprovalRemember(seconds: nil, title: "Just this once"), ApprovalRemember(seconds: nil, title: "Always for this folder")],
            verifier: verifier,
            links: [ApprovalLink(title: "Open its inbox", symbol: "tray") {}, ApprovalLink(title: "Its terminal", symbol: "terminal") {}],
            deadline: Date().addingTimeInterval(169), who: request.request?.asker.map(RmWindowContent.askedBy))
        try render(ApprovalDialogView(model: model), to: path)
        verifier.cancel()
    }

    private func render(_ view: some View, to path: String) throws {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, .dark))
        let size = host.fittingSize
        host.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: size.width, height: size.height),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.contentView = host
        window.order(.below, relativeTo: 0)
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        host.setFrameSize(host.fittingSize)
        window.setContentSize(host.fittingSize)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        print("shot \(url.path) \(rep.pixelsWide)x\(rep.pixelsHigh)")
    }
}
