import AppKit
import Combine
@testable import GenesisKit
import SwiftUI
import XCTest

/// The viewer's Settings window, and the two places agent attribution shows. `MARKDOWN_SHOT_DIR` writes them as PNGs.
@MainActor
final class MarkdownSettingsTests: XCTestCase {
    func testTheSettingsMenuOpensTheGitSettingsWithTheAttributionCost() throws {
        let menu = MarkdownViewerMenu.build(appName: "Genesis Markdown")
        let item = try XCTUnwrap(menu.items.first?.submenu?.items.first { $0.title == "Settings…" })
        XCTAssertEqual(item.keyEquivalent, ",")
        XCTAssertTrue(item.target === MarkdownSettingsWindow.shared)

        // Graphite: a test bitmap skips the layers Liquid Glass is made of, so a glass card draws nothing there.
        let view = MarkdownSettingsView(configuration: .shared)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, .graphite)
            .environment(\.colorScheme, .dark)
        let (window, host) = HostedShot.host(view, size: CGSize(width: 520, height: 470))
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        try shot(host, "markdown-settings-git.png")
    }

    func testSplitSyncSettingReachesAModelWithoutAnOpenDocument() async throws {
        let domain = "md-sync-setting-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let center = NotificationCenter()
        let model = MarkdownDocumentsModel(defaults: defaults, notificationCenter: center)
        XCTAssertTrue(model.docs.isEmpty)
        XCTAssertTrue(model.splitScrollSync)
        let changed = expectation(description: "model received the setting")
        let watch = model.$splitScrollSync.dropFirst().sink { enabled in
            if !enabled { changed.fulfill() }
        }
        center.post(name: .markdownSplitSyncChanged, object: false)
        await fulfillment(of: [changed], timeout: 3)
        XCTAssertFalse(model.splitScrollSync)
        XCTAssertEqual(defaults.object(forKey: "markdownWindow.splitScrollSync") as? Bool, false)
        withExtendedLifetime(watch) {}
    }

    func testTheGutterCardNamesTheSessionThatWroteTheHunk() throws {
        let source = AgentBlameSource(provider: "claude", session: "9fae860c-68b8-43fd-b85a-72d538afbedb", turn: "t1",
                                      ts: "2026-10-24T17:40:00Z", prompt: "Fix the blame storm")
        let hunk = GitHunk(kind: .modified, newStart: 11, newCount: 2, oldStart: 11, oldLines: ["The old sentence of this note."])
        let view = GitHunkCard(hunk: hunk, source: source, revert: {})
            .background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, .dark)
        let (window, host) = HostedShot.host(view, size: CGSize(width: 380, height: 170))
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        try shot(host, "markdown-attribution-gutter-card.png")
    }

    private func shot(_ host: NSView, _ name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["MARKDOWN_SHOT_DIR"] else { return }
        let rep = try XCTUnwrap(HostedShot.bitmap(host))
        try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: directory).appendingPathComponent(name))
    }
}
