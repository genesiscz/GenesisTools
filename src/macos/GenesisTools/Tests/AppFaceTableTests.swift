import XCTest
@testable import GenesisToolsHost

/// What the host answers about each face flag: which part serves it, whether it is a window (its argv is recorded and a
/// link relay runs in front of it), what the ⌘Q question calls it and where it lists it, and whether its lifecycle is
/// logged. Written before the per-face tables became one declaration, so the declaration answers exactly what they did.
final class AppFaceTableTests: XCTestCase {
    private struct Expected {
        let argv: [String]
        let part: String?
        let window: Bool
        let quitFace: String?
        let quitName: String?
        let logged: Bool
    }

    private let expected: [Expected] = [
        Expected(argv: [], part: nil, window: true, quitFace: "--window", quitName: "Permissions", logged: true),
        Expected(argv: ["--window"], part: nil, window: true, quitFace: "--window", quitName: "Permissions", logged: true),
        Expected(argv: ["-psn_0_1"], part: nil, window: true, quitFace: "--window", quitName: "Permissions", logged: true),
        Expected(argv: ["--hub"], part: "hub", window: true, quitFace: "--hub", quitName: "Hub", logged: true),
        Expected(argv: ["--review"], part: "hub", window: true, quitFace: "--review", quitName: "Review", logged: true),
        Expected(argv: ["--widget"], part: "widget", window: true, quitFace: "--widget", quitName: "Widget", logged: true),
        Expected(argv: ["--features"], part: "features", window: true, quitFace: "--features", quitName: "Settings", logged: true),
        Expected(argv: ["--clicky"], part: "features", window: true, quitFace: "--features", quitName: "Settings", logged: true),
        Expected(argv: ["--markdown"], part: "markdown", window: true, quitFace: "--markdown", quitName: "Markdown viewer", logged: true),
        // The recorder is a menu bar item: no window, no link relay, never named by the quit question.
        Expected(argv: ["--recorder"], part: "recorder", window: false, quitFace: nil, quitName: nil, logged: true),
        Expected(argv: ["--meetings"], part: "meetings", window: true, quitFace: "--meetings", quitName: "Meetings", logged: true),
        Expected(argv: ["--link-relay"], part: nil, window: false, quitFace: nil, quitName: nil, logged: true),
        Expected(argv: ["--rpc", "{}"], part: nil, window: false, quitFace: nil, quitName: nil, logged: false),
        Expected(argv: ["--mic"], part: nil, window: false, quitFace: nil, quitName: nil, logged: false),
        Expected(argv: ["--capsule"], part: nil, window: false, quitFace: nil, quitName: nil, logged: false),
        Expected(argv: ["--notify"], part: nil, window: false, quitFace: nil, quitName: nil, logged: false),
        Expected(argv: ["https://example.org/"], part: nil, window: false, quitFace: nil, quitName: nil, logged: false),
        Expected(argv: ["/Users/example/.bun/bin/bun", "run", "/tmp/x.ts"], part: nil, window: false, quitFace: nil, quitName: nil, logged: false),
        // Scripted runs are no window. `--headless` stops only the quit question, not the record.
        Expected(argv: ["--meetings", "--snapshot", "/tmp/m.png"], part: "meetings", window: false, quitFace: nil, quitName: nil, logged: false),
        Expected(argv: ["--hub", "--bench", "/tmp/b.json"], part: "hub", window: false, quitFace: nil, quitName: nil, logged: false),
        Expected(argv: ["--features", "--headless"], part: "features", window: true, quitFace: nil, quitName: nil, logged: true),
    ]

    func testEachFaceFlagAnswersThePartTheWindowTheQuitNameAndTheLifecycle() {
        for row in expected {
            let first = row.argv.first ?? ""
            XCTAssertEqual(AppParts.partOfFace[first], row.part, "part of \(row.argv)")
            XCTAssertEqual(FaceRecord.isWindowFace(row.argv), row.window, "window \(row.argv)")
            XCTAssertEqual(LinkRelay.shouldEnsure(row.argv), row.window, "link relay in front of \(row.argv)")
            let face = PartQuit.face(ofArguments: row.argv, preview: false)
            XCTAssertEqual(face, row.quitFace, "quit face of \(row.argv)")
            XCTAssertEqual(face.flatMap { PartQuit.faceNames[$0] }, row.quitName, "quit name of \(row.argv)")
            XCTAssertEqual(FaceLifecycle.isLogged(row.argv), row.logged, "lifecycle of \(row.argv)")
        }
    }

    func testTheQuitQuestionListsTheFacesInItsOrder() {
        XCTAssertEqual(PartQuit.faceOrder, ["--widget", "--features", "--hub", "--review", "--markdown", "--meetings", "--window"])
        XCTAssertEqual(Set(PartQuit.faceNames.keys), Set(PartQuit.faceOrder), "every named face has a place in the order")
    }

    func testEveryPartFaceFlagIsKnown() {
        XCTAssertEqual(
            Set(AppParts.partOfFace.keys),
            ["--hub", "--review", "--widget", "--features", "--clicky", "--markdown", "--recorder", "--meetings"])
    }
}
