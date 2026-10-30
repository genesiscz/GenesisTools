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

    private func params(_ items: [RmApproveItem]) -> RmApproveParams {
        RmApproveParams(
            title: items.count == 1 ? "Delete 1 item for shop-admin-2.0?" : "Delete \(items.count) items for shop-admin-2.0?",
            lines: [], caller: "Claude Code · shop-admin-2.0", folder: "/Users/someone/Projects/shop-web",
            request: RmApproveRequest(
                id: "k7m2xq", kind: "delete", why: "The old exports are replaced by the new admin designs",
                cwd: "/Users/someone/Projects/shop-web", graceMinutes: 60,
                asker: RmApproveAsker(agent: "Claude Code", session: "shop-admin-2.0", project: "shop-web", branch: "develop"),
                items: items))
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
    }

    private func shot(_ items: [RmApproveItem], _ evaluator: StillEvaluator, to path: String) throws {
        let content = RmWindowContent.build(params(items), home: home, icons: false, markdownApp: true)
        let shown = content.items.map { item in
            let raw = items.first { $0.path == item.path }
            return ApprovalItem(path: item.path, location: item.location, name: item.name, folder: item.folder, size: item.size,
                                reason: item.reason, gone: item.gone, aside: item.aside, isFolder: item.isFolder,
                                opensInMarkdown: item.opensInMarkdown,
                                icon: NSWorkspace.shared.icon(for: raw?.kind == "dir" ? .folder : (UTType(filenameExtension: (item.path as NSString).pathExtension) ?? .data)),
                                git: item.git, detail: item.detail, alsoIn: item.alsoIn)
        }
        let verifier = ApprovalVerifier(reason: "approve: fixture", evaluator: evaluator)
        let model = ApprovalDialogModel(
            title: content.title, purpose: content.purpose, symbol: "trash.fill", facts: content.facts, details: content.details,
            warning: nil, footnote: content.footnote,
            rememberChoices: [ApprovalRemember(seconds: nil, title: "Just this once"), ApprovalRemember(seconds: nil, title: "Always for this folder")],
            rememberNote: nil, allowTitle: "Use password…",
            deadline: Date().addingTimeInterval(169), identifier: "rm-approve", items: shown, verifier: verifier,
            links: [ApprovalLink(title: "Open its inbox", symbol: "tray") {}, ApprovalLink(title: "Its terminal", symbol: "terminal") {}],
            summary: content.summary, disposals: content.disposals, hint: "Esc denies · Space previews", selectable: content.selectable)
        model.titleForSelection = { selected, total in RmWindowContent.title(selected: selected, total: total, who: "shop-admin-2.0") }
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
