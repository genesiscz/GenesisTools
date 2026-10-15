import AppKit
import SwiftUI
import XCTest
@testable import GenesisTools

/// The review header's scope menu label for three scopes, drawn in a borderless window that is never ordered front
/// (alpha 0, behind every window, no mouse). Only when `HUB_PICKER_SHOTS` names the PNG to write.
@MainActor
final class ReviewScopeChipShots: XCTestCase {
    func testScopeMenuLabelShot() throws {
        guard let path = ProcessInfo.processInfo.environment["HUB_PICKER_SHOTS"] else {
            throw XCTSkip("pictures only when HUB_PICKER_SHOTS names a file")
        }
        func model(_ scope: DiffScope) -> ReviewModel {
            let model = ReviewModel(repo: URL(fileURLWithPath: "/work/tools"), options: DiffViewOptions(), renderer: NullRenderer())
            model.base = "origin/main"
            model.scope = scope
            return model
        }
        let models = [
            model(.uncommitted),
            model(.branch),
            model(.commit(sha: "8b04d7e" + String(repeating: "0", count: 33), title: "Fix the table that lost its last row")),
        ]
        let size = CGSize(width: 520, height: 140)
        let view = VStack(alignment: .leading, spacing: 10) {
            ForEach(models.indices, id: \.self) { index in
                HStack(spacing: 10) {
                    ScopeMenu(model: models[index])
                    Text(verbatim: "+42")
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundColor(ReviewPalette.added)
                    Text(verbatim: "−7")
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundColor(ReviewPalette.removed)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(14)
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .background(Color(nsColor: ReviewPalette.background))
        .environment(\.colorScheme, .dark)

        _ = NSApplication.shared
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: size.width, height: size.height),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.contentView = host
        window.order(.below, relativeTo: 0)
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        host.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        print("shot \(url.path) \(rep.pixelsWide)x\(rep.pixelsHigh)")
    }
}
