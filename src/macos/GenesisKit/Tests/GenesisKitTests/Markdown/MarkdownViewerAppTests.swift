import XCTest
@testable import GenesisKit

/// The viewer process's menu bar.
@MainActor
final class MarkdownViewerAppTests: XCTestCase {
    func testTheViewerMenuCarriesCloseTabOnCommandWAndCloseWindowOnShiftCommandW() {
        let keys = Keymap(library: MarkdownKeymap.library, store: nil, layout: TableKeyLayout.us)
        let menu = MarkdownViewerMenu.build(appName: "Viewer", keymap: keys)
        let file = menu.items.first { $0.title == "File" }?.submenu
        let closeTab = file?.items.first { $0.title == "Close Tab" }
        XCTAssertEqual(closeTab?.keyEquivalent, "w")
        XCTAssertEqual(closeTab?.keyEquivalentModifierMask, [.command])
        XCTAssertEqual(closeTab?.action, #selector(MarkdownDocumentWindowController.closeSelectedTab(_:)))
        let copyPath = file?.items.first { $0.title == "Copy Path" }
        XCTAssertEqual(copyPath?.keyEquivalent, "c")
        XCTAssertEqual(copyPath?.keyEquivalentModifierMask, [.control, .shift])
        XCTAssertEqual(copyPath?.action, #selector(MarkdownDocumentWindowController.copyPath(_:)))
        let closeWindow = file?.items.first { $0.title == "Close Window" }
        XCTAssertEqual(closeWindow?.keyEquivalent, "w")
        XCTAssertEqual(closeWindow?.keyEquivalentModifierMask, [.command, .shift])
        // Without an Edit menu ⌘C/⌘V never reach the text views.
        let edit = menu.items.first { $0.title == "Edit" }?.submenu
        XCTAssertEqual(edit?.items.map(\.keyEquivalent).filter { !$0.isEmpty }, ["z", "z", "x", "c", "v", "a"])
        XCTAssertEqual(menu.items.first?.submenu?.items.last?.title, "Quit Viewer")
    }
}

/// The URL that launches the viewer arrives before didFinishLaunching, and a
/// window shown that early never appears: URLs wait for launch.
final class MarkdownViewerLaunchQueueTests: XCTestCase {
    func testURLsBeforeLaunchAreQueuedAndReplayedInOrder() {
        var handled: [String] = []
        let delegate = MarkdownViewerDelegate(handle: { handled.append($0.absoluteString) })
        delegate.receive(URL(string: "viewer://open?focus=0")!)
        delegate.receive(URL(string: "viewer://open?path=/tmp/a.md")!)
        XCTAssertEqual(handled, [], "nothing runs before launch")
        XCTAssertEqual(delegate.pendingURLs.count, 2)
        delegate.finishLaunching()
        XCTAssertEqual(handled, ["viewer://open?focus=0", "viewer://open?path=/tmp/a.md"])
        XCTAssertEqual(delegate.pendingURLs, [])
        delegate.receive(URL(string: "viewer://open?path=/tmp/b.md")!)
        XCTAssertEqual(handled.last, "viewer://open?path=/tmp/b.md", "after launch a URL runs at once")
    }
}
