import XCTest
@testable import GenesisKit

final class DefaultAppTests: XCTestCase {
    private func app(_ schemes: [String]) -> DefaultApp {
        DefaultApp(url: URL(fileURLWithPath: "/Applications/Editor.app"), name: "Editor", bundleIdentifier: nil, schemes: schemes)
    }

    func testAnEditorWithALineSchemeOpensAtTheLine() {
        XCTAssertEqual(
            app(["cursor"]).lineURL(path: "/Users/me/src/a.go", line: 20)?.absoluteString,
            "cursor://file/Users/me/src/a.go:20"
        )
        XCTAssertEqual(
            app(["vscode"]).lineURL(path: "/tmp/x.ts", line: 3)?.absoluteString,
            "vscode://file/tmp/x.ts:3"
        )
    }

    func testAPathWithASpaceIsEncoded() {
        XCTAssertEqual(
            app(["cursor"]).lineURL(path: "/tmp/My Notes/a b.ts", line: 7)?.absoluteString,
            "cursor://file/tmp/My%20Notes/a%20b.ts:7"
        )
    }

    func testNoLineOrNoEditorSchemeMeansAPlainOpen() {
        XCTAssertNil(app(["cursor"]).lineURL(path: "/tmp/x.ts", line: nil))
        XCTAssertNil(app(["cursor"]).lineURL(path: "/tmp/x.ts", line: 0))
        XCTAssertNil(app(["xcode", "atom"]).lineURL(path: "/tmp/x.ts", line: 4))
        XCTAssertNil(app([]).lineURL(path: "/tmp/x.ts", line: 4))
        XCTAssertTrue(app(["vscode"]).opensAtLine)
        XCTAssertFalse(app(["xcode"]).opensAtLine)
    }

    func testTheNameDropsTheAppExtension() {
        XCTAssertEqual(DefaultApp.displayName(URL(fileURLWithPath: "/Applications/Not Installed Editor.app")), "Not Installed Editor")
    }
}
