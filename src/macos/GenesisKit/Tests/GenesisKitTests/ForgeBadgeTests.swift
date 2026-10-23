import AppKit
import SwiftUI
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

final class ForgeBadgeTests: XCTestCase {
    func testBothMarksSpanTheirSixteenUnitBoxAndStayInIt() {
        for (name, path) in [("github", ForgeMark.github), ("gitlab", ForgeMark.gitlab)] {
            let box = path.boundingRect
            XCTAssertTrue(CGRect(x: -0.1, y: -0.1, width: 16.2, height: 16.2).contains(box), "\(name) \(box)")
            XCTAssertGreaterThan(box.width, 15.5, name)
            XCTAssertGreaterThan(box.height, 13.5, name)
        }
    }

    func testCompactNumbersSplitAtASecondDotAndAMinus() {
        // `.5.5` is 0.5 then 0.5; `-.5` starts a new number.
        let path = SVGPath.parse("M0 0l.5.5-.5.5z")
        XCTAssertEqual(path.boundingRect, CGRect(x: 0, y: 0, width: 0.5, height: 1))
    }

    func testAnUnknownCommandEndsThePathInsteadOfMisdrawing() {
        let path = SVGPath.parse("M0 0L4 4Q1 1 9 9")
        XCTAssertEqual(path.boundingRect, CGRect(x: 0, y: 0, width: 4, height: 4))
    }

    func testForgeWordsFollowTheHost() {
        XCTAssertEqual(Forge(kind: "github")?.label(436), "#436")
        XCTAssertEqual(Forge(kind: "GitLab")?.label(7412), "!7412")
        XCTAssertEqual(Forge(kind: "gitlab")?.noun, "MR")
        XCTAssertNil(Forge(kind: "bitbucket"))
        XCTAssertNil(Forge(kind: nil))
    }

    func testProviderMarksParseToTheEndAndFillTheirBox() {
        for kind in AIProviderMark.Kind.allCases {
            let box = (AIProviderMark.paths[kind] ?? Path()).boundingRect
            XCTAssertGreaterThan(box.width, 20, "\(kind) spans its 24-unit box (a path cut short by an arc stays small)")
            XCTAssertGreaterThan(box.height, 20, "\(kind)")
            XCTAssertLessThanOrEqual(box.maxX, 24.5, "\(kind)")
            XCTAssertGreaterThanOrEqual(box.minY, -0.5, "\(kind)")
        }
        XCTAssertEqual(AIProviderMark.Kind(provider: "anthropic-sub"), .claude)
        XCTAssertEqual(AIProviderMark.Kind(provider: "openai-sub"), .codex)
        XCTAssertEqual(AIProviderMark.Kind(provider: "Grok"), .grok)
        XCTAssertNil(AIProviderMark.Kind(provider: "gemini"), "an agent with no mark keeps its letter")
    }

    func testAnArcWithPackedFlagsReachesItsEndPoint() {
        // `a1 1 0 012 0` is flags 0 and 1, then the point (2, 0): a half circle from (0, 0) to (2, 0).
        let path = SVGPath.parse("M0 0a1 1 0 012 0")
        XCTAssertEqual(path.currentPoint?.x ?? 0, 2, accuracy: 0.001)
        XCTAssertEqual(path.boundingRect.height, 1, accuracy: 0.05, "the half circle bulges by its radius")
    }

    /// Renders every provider glyph style to a PNG, for the eye: PROVIDER_MARKS_RENDER=<out.png>.
    @MainActor
    func testRenderProviderMarks() throws {
        guard let out = ProcessInfo.processInfo.environment["PROVIDER_MARKS_RENDER"] else {
            throw XCTSkip("set PROVIDER_MARKS_RENDER")
        }
        let view = VStack(alignment: .leading, spacing: 10) {
            ForEach(["claude", "codex", "grok", "gemini"], id: \.self) { provider in
                HStack(spacing: 12) {
                    AIProviderGlyph(meta: AIProviders.meta(for: provider), size: 32)
                    AIProviderGlyph(meta: AIProviders.meta(for: provider), size: 18)
                    AIProviderGlyph(meta: AIProviders.meta(for: provider), size: 11)
                    AIProviderGlyph(meta: AIProviders.meta(for: provider), size: 24, style: .plain)
                    ProviderBadge(provider: provider, size: 24)
                    Text(provider).foregroundStyle(.white)
                }
            }
        }.padding(16).background(Color(white: 0.1))
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage)
        let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: out))
    }
}
