import UserNotifications
import XCTest
@testable import GenesisKit
@testable import GenesisKitBase

private final class FakeCenter: NotificationCenterPort {
    var added: [UNNotificationRequest] = []
    var removed: [String] = []
    var categorySet: Set<UNNotificationCategory> = []
    var deliveredNotes: [DeliveredNotification] = []
    var failNextAdd = false
    var delayDelivered = false
    var deliveredCallbacks: [([DeliveredNotification]) -> Void] = []

    func add(_ request: UNNotificationRequest, completion: @escaping (Error?) -> Void) {
        if failNextAdd {
            failNextAdd = false
            completion(NSError(domain: "fake", code: 1, userInfo: [NSLocalizedDescriptionKey: "denied"]))
            return
        }
        added.append(request)
        deliveredNotes.append(DeliveredNotification(identifier: request.identifier,
                                                    category: request.content.categoryIdentifier,
                                                    threadId: request.content.threadIdentifier,
                                                    userInfo: request.content.userInfo))
        completion(nil)
    }

    func delivered(_ completion: @escaping ([DeliveredNotification]) -> Void) {
        if delayDelivered { deliveredCallbacks.append(completion) } else { completion(deliveredNotes) }
    }

    func finishDelivered(at index: Int = 0) {
        let callback = deliveredCallbacks.remove(at: index)
        callback(deliveredNotes)
    }

    func removeDelivered(identifiers: [String]) {
        removed += identifiers
        deliveredNotes.removeAll { identifiers.contains($0.identifier) }
    }

    func categories(_ completion: @escaping (Set<UNNotificationCategory>) -> Void) { completion(categorySet) }
    func setCategories(_ categories: Set<UNNotificationCategory>) { categorySet = categories }
}

final class NotificationEngineTests: XCTestCase {
    private var center: FakeCenter!
    private var engine: NotificationEngine!
    private var ledger: String!

    override func setUpWithError() throws {
        center = FakeCenter()
        ledger = FileManager.default.temporaryDirectory.appendingPathComponent("engine-ledger-\(UUID()).jsonl").path
        let fake = center!
        engine = NotificationEngine(centerProvider: { fake }, ledgerFile: ledger)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: ledger)
    }

    private func ledgerLines() throws -> [[String: Any]] {
        NotificationLedger.flush()
        guard FileManager.default.fileExists(atPath: ledger) else { return [] }
        return try String(contentsOfFile: ledger, encoding: .utf8).split(separator: "\n")
            .map { try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]) }
    }

    func testAReplaceKeyLeavesOneCardPerKey() throws {
        let first = engine.post(EngineNotification(source: "monitor.cache", title: "10 min left", body: "s1",
                                                   replaceKey: "s1"))
        engine.post(EngineNotification(source: "monitor.cache", title: "other session", body: "s2", replaceKey: "s2"))
        let third = engine.post(EngineNotification(source: "monitor.cache", title: "5 min left", body: "s1",
                                                   replaceKey: "s1"))
        guard case .posted(let firstId) = first, case .posted(let thirdId) = third else { return XCTFail("posted") }
        XCTAssertEqual(center.removed, [firstId], "only the older card of the same key goes")
        XCTAssertEqual(Set(center.deliveredNotes.map(\.identifier)).contains(thirdId), true)
        XCTAssertEqual(center.deliveredNotes.count, 2)
        XCTAssertEqual(center.added.last?.content.threadIdentifier, "s1", "the key threads the cards")
    }

    func testReplacementWaitsForOlderSweepAndAllowsOtherKeysToCompleteOutOfOrder() {
        center.delayDelivered = true
        engine.post(EngineNotification(source: "disk", title: "first", body: "b", identifier: "first", replaceKey: "key"))
        engine.post(EngineNotification(source: "disk", title: "latest", body: "b", identifier: "latest", replaceKey: "key"))
        engine.post(EngineNotification(source: "disk", title: "other", body: "b", identifier: "other", replaceKey: "other"))
        XCTAssertEqual(center.added.map(\.identifier), ["first", "other"])
        center.finishDelivered(at: 1)
        center.finishDelivered()
        XCTAssertEqual(center.added.map(\.identifier), ["first", "other", "latest"])
        center.finishDelivered()
        XCTAssertEqual(Set(center.deliveredNotes.map(\.identifier)), ["latest", "other"])
        XCTAssertEqual(center.removed, ["first"])
    }

    func testFailedReplacementReleasesTheNextPost() {
        center.delayDelivered = true
        engine.post(EngineNotification(source: "disk", title: "first", body: "b", replaceKey: "key"))
        engine.post(EngineNotification(source: "disk", title: "failed", body: "b", replaceKey: "key"))
        engine.post(EngineNotification(source: "disk", title: "last", body: "b", identifier: "last", replaceKey: "key"))
        center.failNextAdd = true
        center.finishDelivered()
        center.finishDelivered()
        XCTAssertEqual(center.deliveredNotes.map(\.identifier), ["last"])
    }

    func testAQuietRuleHoldsTheCardBackAndTheLedgerSaysWhy() throws {
        engine.addQuietRule("focus") { $0.source == "server.notify" ? "focus session active" : nil }
        XCTAssertEqual(engine.post(EngineNotification(source: "server.notify", title: "t", body: "b")),
                       .suppressed(reason: "focus: focus session active"))
        if case .posted = engine.post(EngineNotification(source: "disk", title: "t", body: "b")) {} else {
            XCTFail("another source still posts")
        }
        XCTAssertEqual(center.added.count, 1)
        let lines = try ledgerLines()
        XCTAssertEqual(lines.map { $0["outcome"] as? String }, ["suppressed", "posted"])
        XCTAssertEqual(lines[0]["reason"] as? String, "focus: focus session active")
    }

    func testCategoriesAreAddedToTheRegisteredSetNeverReplacingIt() {
        center.categorySet = [UNNotificationCategory(identifier: "someone.else", actions: [], intentIdentifiers: [])]
        engine.register(categories: [UNNotificationCategory(identifier: "genesis.disk", actions: [], intentIdentifiers: [])])
        engine.post(EngineNotification(source: "tools", title: "t", body: "b", identifier: "card-1",
                                       actions: [UNNotificationAction(identifier: "ok", title: "OK")]))
        XCTAssertEqual(Set(center.categorySet.map(\.identifier)), ["someone.else", "genesis.disk", "card-1"])
        XCTAssertEqual(center.added.first?.content.categoryIdentifier, "card-1", "ad-hoc buttons use the card's id")
    }

    func testAFailedAddIsRecordedAsFailed() throws {
        center.failNextAdd = true
        let failed = expectation(description: "completion")
        engine.post(EngineNotification(source: "hang", title: "t", body: "b", ledgerFields: ["stallSeconds": 21])) {
            XCTAssertNotNil($0)
            failed.fulfill()
        }
        wait(for: [failed], timeout: 1)
        let lines = try ledgerLines()
        XCTAssertEqual(lines.map { $0["outcome"] as? String }, ["posted", "failed"])
        XCTAssertEqual(lines[1]["reason"] as? String, "denied")
        XCTAssertEqual(lines[0]["stallSeconds"] as? Int, 21)
    }

    func testWithdrawByKeyAndCountByCategory() throws {
        engine.post(EngineNotification(source: "disk", title: "full", body: "b", replaceKey: "disk.full",
                                       category: "genesis.disk"))
        engine.post(EngineNotification(source: "monitor.cache", title: "t", body: "b", category: "genesis.monitor.session"))
        var counted: [String] = []
        engine.delivered(where: { $0.category == "genesis.monitor.session" }) { counted = $0 }
        XCTAssertEqual(counted.count, 1)
        var withdrawn: [String] = []
        engine.withdraw(replaceKey: "disk.full") { withdrawn = $0 }
        XCTAssertEqual(withdrawn.count, 1)
        XCTAssertEqual(center.deliveredNotes.map(\.category), ["genesis.monitor.session"])
        engine.withdraw(where: { $0.category == "genesis.monitor.session" })
        engine.withdraw(replaceKey: "disk.full")
        let withdrawnLines = try ledgerLines().filter { $0["outcome"] as? String == "withdrawn" }
        XCTAssertEqual(withdrawnLines.count, 2, "one line per removed card, none for a no-op")
        XCTAssertEqual(withdrawnLines[0]["source"] as? String, "disk")
        XCTAssertEqual(withdrawnLines[0]["id"] as? String, withdrawn.first)
        XCTAssertEqual(withdrawnLines[0]["replaceKey"] as? String, "disk.full")
        XCTAssertEqual(withdrawnLines[1]["source"] as? String, "monitor.cache")
    }

    func testNoCenterMeansNothingPostedAndNothingRecorded() throws {
        let quiet = NotificationEngine(centerProvider: { nil }, ledgerFile: ledger)
        XCTAssertEqual(quiet.post(EngineNotification(source: "x", title: "t", body: "b")), .unavailable)
        XCTAssertTrue(try ledgerLines().isEmpty)
    }
}
