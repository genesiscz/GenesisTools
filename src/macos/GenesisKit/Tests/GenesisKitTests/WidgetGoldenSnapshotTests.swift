import Foundation
import GenesisKitFixtures
import XCTest
@testable import GenesisKit

/// The golden widget snapshots in GenesisKitFixtures/Widget, which src/hub/lib/widget/snapshot-golden.test.ts writes
/// from the real snapshot builder. Each one must decode the way the widget decodes a snapshot line, and every card in
/// them must have a kind this build knows. A field the builder renames, or a kind it adds, fails here and not in the
/// running widget.
final class WidgetGoldenSnapshotTests: XCTestCase {
    /// Every known case; `testTheGoldenSnapshotsHoldEveryCardKind` fails when a golden file stops carrying one.
    private static let known: [WidgetCardKind] = [.decision, .dialog, .todo, .form, .answer, .result]

    private func snapshots() throws -> [(name: String, snapshot: WidgetSnapshot)] {
        let names = try KitFixture.names(in: "Widget").filter { $0.hasSuffix(".json") }
        XCTAssertFalse(names.isEmpty, "GenesisKitFixtures/Widget holds no golden snapshot")
        return try names.map { name in
            do {
                return (name, try JSONDecoder().decode(WidgetSnapshot.self, from: KitFixture.data(name, in: "Widget")))
            } catch {
                XCTFail("\(name) does not decode as a WidgetSnapshot: \(error)")
                throw error
            }
        }
    }

    func testEveryGoldenSnapshotDecodesWithKnownCardKinds() throws {
        for (name, snapshot) in try snapshots() {
            XCTAssertFalse(snapshot.cards.isEmpty, "\(name) has no cards")
            let unknown = snapshot.cards.compactMap { card -> String? in
                if case .unknown(let kind) = card.kind { return "\(card.id): \(kind)" }
                return nil
            }
            XCTAssertEqual(unknown, [], "\(name) has cards of a kind WidgetCardKind does not know")
        }
    }

    func testTheGoldenSnapshotsHoldEveryCardKind() throws {
        let seen = Set(try snapshots().flatMap { $0.snapshot.cards.map(\.kind) })
        XCTAssertEqual(Self.known.filter { !seen.contains($0) }, [])
    }

    func testTheStagedDecisionSnapshotCarriesItsOpenDecision() throws {
        let snapshot = try JSONDecoder().decode(
            WidgetSnapshot.self, from: KitFixture.data("snapshot-staged-decision.json", in: "Widget"))
        let card = try XCTUnwrap(snapshot.cards.first)
        XCTAssertEqual(card.kind, .decision)
        XCTAssertTrue(card.needsAnswer)
        XCTAssertEqual(card.choices.map(\.id), ["a", "b"])
        XCTAssertEqual(snapshot.notifications?.sessions.first?.pendingItem?.id, card.id)
    }

    /// A kind a newer hub adds decodes to `unknown` with its text, so the rest of the snapshot still reaches the widget.
    func testAKindThisBuildDoesNotKnowDecodesAsUnknownWithItsText() throws {
        let text = try XCTUnwrap(
            String(data: try KitFixture.data("snapshot-staged-decision.json", in: "Widget"), encoding: .utf8))
        let planted = text.replacingOccurrences(of: "\"kind\": \"decision\",\n            \"sourceContext\"",
                                                with: "\"kind\": \"poll\",\n            \"sourceContext\"")
        XCTAssertNotEqual(planted, text, "the plant found no card kind to replace")
        let snapshot = try JSONDecoder().decode(WidgetSnapshot.self, from: Data(planted.utf8))
        let card = try XCTUnwrap(snapshot.cards.first)
        XCTAssertEqual(card.kind, .unknown("poll"))
        XCTAssertEqual(card.kind.rawValue, "poll")
        XCTAssertFalse(card.needsAnswer)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(card)) as? [String: Any]
        XCTAssertEqual(encoded?["kind"] as? String, "poll")
    }
}
