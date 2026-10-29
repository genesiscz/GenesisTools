import LocalAuthentication
import XCTest
@testable import GenesisToolsHost

/// What the `tools rm` approval window (Sources/Host/RmApprove.swift) shows. With the request's rows: a title and a
/// purpose that name who asks, one row per item (name, folder, size, the reason in words), and the request id in the
/// footnote. Without rows (a settings change, an older CLI): who asked, the first lines, and the rest folded into
/// Details, so a long request never grows the window past the screen.
final class RmApproveTests: XCTestCase {
    private func request(_ items: [RmApproveItem], asker: RmApproveAsker? = RmApproveAsker(agent: "Claude Code", session: "shop-admin", project: "shop-web", branch: "develop"),
                         kind: String = "delete", grace: Int? = 60) -> RmApproveParams {
        RmApproveParams(
            title: "Delete 2 items for shop-admin?", lines: ["/x"], caller: "Claude Code · shop-admin", folder: "/elsewhere",
            request: RmApproveRequest(id: "abc234", kind: kind, why: "the old exports are replaced", cwd: "/Users/someone/Projects/shop-web",
                                      graceMinutes: grace, asker: asker, items: items))
    }

    func testRowsNameTheItemWhereItSitsItsSizeAndWhy() {
        let items = [
            RmApproveItem(path: "/Users/someone/Notes/Design/Dark 2", kind: "dir", bytes: 0, empty: true, storedAt: nil,
                          reason: "Outside this session's scratch, its own files and the trusted folders"),
            RmApproveItem(path: "/Users/someone/Notes/Design/Export.md", kind: "file", bytes: 12_400, empty: nil,
                          storedAt: "/tmp/cc/aside/Export.md", reason: "Holds 3 files git does not track in ~/Notes"),
            RmApproveItem(path: "/Users/someone/Notes/old.txt", kind: "missing", bytes: nil, empty: nil, storedAt: nil, reason: "Gone"),
        ]
        let content = RmWindowContent.build(request(items), home: "/Users/someone", icons: false, markdownApp: true)

        XCTAssertEqual(content.title, "Delete 2 items for shop-admin?")
        XCTAssertEqual(content.purpose, "Claude Code in shop-web (develop) wants to delete these. They go to the trash, and tools rm restore brings them back for 1 hour.")
        XCTAssertEqual(content.facts.map(\.label), ["Reason", "Folder"])
        XCTAssertEqual(content.facts.last?.value, "~/Projects/shop-web")
        XCTAssertEqual(content.footnote, "Request abc234. Every decision is written to the tools rm ledger.")
        XCTAssertTrue(content.details.isEmpty)

        XCTAssertEqual(content.items.map(\.name), ["Dark 2", "Export.md", "old.txt"])
        XCTAssertEqual(content.items.map(\.folder), ["~/Notes/Design", "~/Notes/Design", "~/Notes"])
        XCTAssertEqual(content.items.map(\.size), ["Empty folder", "12 kB", "Already gone"])
        XCTAssertEqual(content.items.map(\.gone), [false, false, true])
        XCTAssertEqual(content.items.map(\.reason).first, "Outside this session's scratch, its own files and the trusted folders")
        // An aside item opens where it waits; only a markdown file that is there offers Genesis Markdown.
        XCTAssertEqual(content.items[1].location, "/tmp/cc/aside/Export.md")
        XCTAssertTrue(content.items[1].aside)
        XCTAssertEqual(content.items.map(\.opensInMarkdown), [false, true, false])
        XCTAssertFalse(RmWindowContent.build(request(items), home: "/Users/someone", icons: false, markdownApp: false).items[1].opensInMarkdown)
    }

    func testSizesAndGraceAreWords() {
        func size(_ kind: String, _ bytes: Int64?, empty: Bool? = nil) -> String? {
            RmWindowContent.size(RmApproveItem(path: "/x", kind: kind, bytes: bytes, empty: empty, storedAt: nil, reason: ""))
        }
        XCTAssertEqual(size("dir", 0, empty: true), "Empty folder")
        XCTAssertEqual(size("file", 0), "Empty file")
        XCTAssertEqual(size("dir", 3_210_000_000), "3.21 GB")
        XCTAssertEqual(size("missing", 10), "Already gone")
        XCTAssertNil(size("file", nil))

        XCTAssertEqual(RmWindowContent.graceSentence(90), "They go to the trash, and tools rm restore brings them back for 90 minutes.")
        XCTAssertEqual(RmWindowContent.graceSentence(0), "They go to the trash, which is emptied right away.")
    }

    func testAPersonRunAndARootRequestSayWhatHappens() {
        let person = RmWindowContent.build(request([], asker: nil, grace: 120), icons: false, markdownApp: false)
        XCTAssertEqual(person.purpose, "No rule allows deleting these, so they need you. They go to the trash, and tools rm restore brings them back for 2 hours.")

        let root = RmWindowContent.build(request([], kind: "root", grace: nil), icons: false, markdownApp: false)
        XCTAssertEqual(root.purpose, "Claude Code in shop-web (develop) wants you to trust this folder. Agents may then delete anything inside it without asking.")
    }

    func testWithoutRowsItShowsTheCallerAndFoldsLongLists() {
        let lines = (1...9).map { "/tmp/item-\($0)" }
        let params = RmApproveParams(title: "Delete 9 paths?", lines: lines, caller: "codex · fix-build", folder: "/Users/someone/Projects/app")
        let content = RmWindowContent.build(params, home: "/Users/someone")

        XCTAssertEqual(content.facts.first?.label, "Asked by")
        XCTAssertEqual(content.facts.first?.value, "codex · fix-build")
        XCTAssertEqual(content.facts.filter(\.monospaced).map(\.value), Array(lines.prefix(6)))
        XCTAssertEqual(content.facts.last?.value, "3 more items in Details")
        XCTAssertEqual(content.details.map(\.value), Array(lines.suffix(3)))
        XCTAssertEqual(content.details.map(\.label), ["7", "8", "9"])
        XCTAssertEqual(Set(content.facts.map(\.id)).count, content.facts.count)
        XCTAssertTrue(content.items.isEmpty)
    }

    func testAPersonRunHasNoCallerAndNoDetails() {
        let params = RmApproveParams(title: "Set approval to code?", lines: ["approval = code"], caller: nil, folder: nil)
        let content = RmWindowContent.build(params)

        XCTAssertEqual(content.facts.map(\.value), ["approval = code"])
        XCTAssertTrue(content.details.isEmpty)
    }

    func testTheRequestDecodesFromTheCLIPayload() throws {
        let json = #"""
        {"title":"Delete 1 item for shop?","lines":["a"],"folder":"/w","request":{"id":"abc234","kind":"delete","why":null,
        "cwd":"/w","graceMinutes":60,"asker":{"agent":"Codex"},"items":[{"path":"/w/a","kind":"dir","bytes":0,"empty":true,
        "reason":"Outside"}]}}
        """#
        let params = try JSONDecoder().decode(RmApproveParams.self, from: Data(json.utf8))
        XCTAssertEqual(params.request?.items.first?.empty, true)
        XCTAssertEqual(params.request?.asker?.agent, "Codex")
        XCTAssertNil(params.request?.why)
        let old = try JSONDecoder().decode(RmApproveParams.self, from: Data(#"{"title":"t","lines":["a"]}"#.utf8))
        XCTAssertNil(old.request)
    }

    /// A failed or cancelled touch lets the person try again; only Touch ID being out sends them to the password.
    func testAFailedTouchNeverDenies() {
        XCTAssertEqual(ApprovalVerifier.outcome(for: .authenticationFailed),
                       .retry("Touch ID did not recognize the finger. Try again, or use your password."))
        XCTAssertEqual(ApprovalVerifier.outcome(for: .userCancel), .retry("Touch ID stopped listening. Try again, or use your password."))
        XCTAssertEqual(ApprovalVerifier.outcome(for: .systemCancel), .retry("Touch ID stopped listening. Try again, or use your password."))
        XCTAssertEqual(ApprovalVerifier.outcome(for: .appCancel), .ignore)
        XCTAssertEqual(ApprovalVerifier.outcome(for: .userFallback), .password)
        XCTAssertEqual(ApprovalVerifier.outcome(for: .biometryLockout), .passwordOnly("Touch ID is locked after too many tries. Use your password."))
    }
}
