import AppKit
import SwiftUI
import XCTest
@testable import GenesisToolsHost

@MainActor
final class RequestPresentShots: XCTestCase {
    func testNoticeShots() throws {
        guard let prefix = ProcessInfo.processInfo.environment["REQUEST_PRESENT_SHOTS"] else {
            throw XCTSkip("set REQUEST_PRESENT_SHOTS to a file prefix for rendered pictures")
        }
        var request = try RequestPresentTests.request()
        request.deadlineSeconds = 120
        request.title = "Your export is ready"
        request.reason = "The report finished and is ready to read. Acknowledge this notice to close it."
        try render(request, to: prefix + "-notice.png")
        request.reason = Array(repeating: "The export includes the selected entries and their attachments. The original files are still available in the project.", count: 6).joined(separator: "\n\n")
        try render(request, to: prefix + "-long-reason.png")
    }
    private func render(_ params: RequestPresentParams, to path: String) throws {
        _ = NSApplication.shared
        let model = RequestWindowContent.build(params)
        let host = NSHostingView(rootView: ApprovalDialogView(model: model).background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, .dark))
        host.frame = CGRect(origin: .zero, size: host.fittingSize)
        let window = NSWindow(contentRect: CGRect(origin: CGPoint(x: -10_000, y: -10_000), size: host.fittingSize), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.contentView = host
        window.order(.below, relativeTo: 0)
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        host.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        try FileManager.default.createDirectory(at: URL(fileURLWithPath: path).deletingLastPathComponent(), withIntermediateDirectories: true)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: path))
    }
}
