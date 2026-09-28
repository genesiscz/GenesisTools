import ApplicationServices
import Foundation
import XCTest
@testable import SnapshotSupport

/// Elements keyed by a fake pid: `AXUIElementCreateApplication` builds a real, hashable
/// handle without touching the AX server, so the builder is exercised exactly as in production.
private struct FakeNode {
    var role: String
    var subrole: String? = nil
    var attributes: [String: Any] = [:]
    var children: [pid_t] = []
    var actions: [String] = []
    var settable: Bool? = nil
    var frame = CGRect(x: 0, y: 0, width: 100, height: 100)
    var childrenError: AXError? = nil
    /// The element went away during the walk (`VanishedElement`).
    var vanished = false
}

private final class FakeSource: HierarchySource {
    var nodes: [pid_t: FakeNode] = [:]
    private var handles: [pid_t: AXUIElement] = [:]

    func element(_ pid: pid_t) -> AXUIElement {
        if let handle = handles[pid] {
            return handle
        }
        let handle = AXUIElementCreateApplication(pid)
        handles[pid] = handle
        return handle
    }

    private func pid(_ element: AXUIElement) -> pid_t {
        var value: pid_t = 0
        AXUIElementGetPid(element, &value)
        return value
    }

    func attribute(_ element: AXUIElement, _ name: String) -> Any? {
        guard let node = nodes[pid(element)] else {
            return nil
        }
        switch name {
        case "AXRole": return node.role
        case "AXSubrole": return node.subrole
        case kAXPositionAttribute:
            var point = node.frame.origin
            return AXValueCreate(.cgPoint, &point)
        case kAXSizeAttribute:
            var size = node.frame.size
            return AXValueCreate(.cgSize, &size)
        default: return node.attributes[name]
        }
    }

    func children(of element: AXUIElement) throws -> [AXUIElement] {
        guard let node = nodes[pid(element)] else {
            return []
        }
        if node.vanished {
            throw VanishedElement()
        }
        if let error = node.childrenError {
            throw ObservedTreeError("AX tree read failed (\(error.rawValue)); refresh instead of assuming an empty subtree")
        }
        return node.children.map(self.element)
    }

    func actionNames(of element: AXUIElement) -> [String] {
        nodes[pid(element)]?.actions ?? []
    }

    func isValueSettable(_ element: AXUIElement) -> Bool? {
        nodes[pid(element)]?.settable
    }
}

final class ObservedTreeBuilderTests: XCTestCase {
    func testBulkNodesWithoutRolesTriggerFallbackInsteadOfEmptyActionableRows() throws {
        let keys = BulkHierarchyKeys(arrayAttributes:"arrays",maxArrayCount:"max",maxDepth:"depth",returnAttributeErrors:"errors",incomplete:"incomplete",count:"count",error:"error",value:"value")
        let element = AXUIElementCreateApplication(999999)
        var keyCallbacks = kCFTypeDictionaryKeyCallBacks
        var valueCallbacks = kCFTypeDictionaryValueCallBacks
        let dictionary = CFDictionaryCreateMutable(nil, 0, &keyCallbacks, &valueCallbacks)!
        let missing: NSDictionary = ["AXChildren":["value":[]]]
        CFDictionarySetValue(dictionary, Unmanaged.passUnretained(element).toOpaque(), Unmanaged.passUnretained(missing).toOpaque())
        let source = BulkHierarchySource(dictionary: dictionary, keys: keys)
        XCTAssertThrowsError(try source.children(of: element)) { error in
            guard case BulkHierarchyError.missingElement = error else { return XCTFail("Expected structural fallback") }
        }
        let valid: NSDictionary = ["AXRole":["value":"AXWindow"],"AXChildren":["value":[]]]
        CFDictionarySetValue(dictionary, Unmanaged.passUnretained(element).toOpaque(), Unmanaged.passUnretained(valid).toOpaque())
        XCTAssertTrue(try source.children(of: element).isEmpty)
    }
    private func source() -> FakeSource {
        let source = FakeSource()
        source.nodes[1] = FakeNode(role: "AXWindow", attributes: ["AXTitle": "Main"], children: [2, 3], frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        source.nodes[2] = FakeNode(role: "AXButton", attributes: ["AXDescription": "Save", "AXEnabled": NSNumber(value: true)], actions: ["AXShowMenu", "AXPress"], settable: false, frame: CGRect(x: 10, y: 10, width: 50, height: 20))
        source.nodes[3] = FakeNode(role: "AXGroup", children: [4], frame: CGRect(x: 0, y: 100, width: 400, height: 200))
        source.nodes[4] = FakeNode(role: "AXStaticText", attributes: ["AXValue": "hello"], settable: false, frame: CGRect(x: 20, y: 120, width: 60, height: 20))
        return source
    }

    func testRowsAreIndexedInPreOrderWithTheContractFields() throws {
        let fake = source()
        let tree = try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window")
        XCTAssertEqual(tree.rows.map { $0["index"] as? Int }, [0, 1, 2, 3])
        XCTAssertEqual(tree.rows.map { $0["depth"] as? Int }, [0, 1, 1, 2])
        XCTAssertEqual(tree.rows.map { $0["role"] as? String }, ["AXWindow", "AXButton", "AXGroup", "AXStaticText"])
        let button = tree.rows[1]
        XCTAssertEqual(button["actions"] as? [String], ["AXPress", "AXShowMenu"], "actions are sorted")
        XCTAssertEqual(button["AXDescription"] as? String, "Save")
        XCTAssertEqual(button["AXEnabled"] as? String, "1", "booleans arrive as strings, like the live walk")
        XCTAssertNil(button["valueSettable"], "no AXValue means settability is never asked; one IPC per element saved")
        XCTAssertEqual(button["x"] as? Int, 10)
        XCTAssertEqual(button["visible"] as? Bool, true)
        XCTAssertEqual(tree.rows[3]["valueSettable"] as? Bool, false, "an element with a value reports settability")
        XCTAssertEqual(tree.frames.count, 4)
        XCTAssertEqual(tree.digest.count, 64)
    }

    func testAVanishedElementLeavesNoRowAndNoSubtree() throws {
        let fake = source()
        fake.nodes[3]?.vanished = true
        let tree = try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window")
        XCTAssertEqual(tree.rows.map { $0["role"] as? String }, ["AXWindow", "AXButton"], "the group and its text are gone")
        XCTAssertEqual(tree.elements.count, 2)
        XCTAssertEqual(tree.vanished, 1)
    }

    func testSharedChildIsVisitedOnce() throws {
        let fake = source()
        fake.nodes[3]?.children = [4, 4]
        fake.nodes[1]?.children = [2, 3, 4]
        let tree = try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window")
        XCTAssertEqual(tree.rows.count, 4)
    }

    func testValidationChangeInvalidatesTheObservationWithoutChangingItsValue() throws {
        let fake = source()
        fake.nodes[4] = FakeNode(role: "AXTextField", attributes: ["AXValue": "unchanged", "AXInvalid": "false"], settable: true)
        let valid = try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window")
        fake.nodes[4]?.attributes["AXInvalid"] = "true"
        let invalid = try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window")
        XCTAssertEqual(valid.rows[3]["AXValue"] as? String, invalid.rows[3]["AXValue"] as? String)
        XCTAssertEqual(invalid.rows[3]["AXInvalid"] as? String, "true")
        XCTAssertNotEqual(valid.digest, invalid.digest)
    }

    func testDepthOverflowIsRefusedNotTruncated() {
        let fake = source()
        XCTAssertThrowsError(try buildObservedTree(root: fake.element(1), source: fake, depth: 1, scope: "window")) { error in
            XCTAssertEqual((error as? ObservedTreeError)?.message, "AX tree exceeds --depth 1; increase depth and run see again")
        }
    }

    func testDepthBoundsAreValidated() {
        let fake = source()
        XCTAssertThrowsError(try buildObservedTree(root: fake.element(1), source: fake, depth: 0, scope: "window"))
        XCTAssertThrowsError(try buildObservedTree(root: fake.element(1), source: fake, depth: 51, scope: "window"))
    }

    func testChromeScopeOmitsWebAreaDescendantsAndSaysSo() throws {
        let fake = source()
        fake.nodes[3] = FakeNode(role: "AXWebArea", children: [4])
        let chrome = try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "chrome")
        XCTAssertEqual(chrome.rows.count, 3)
        XCTAssertEqual(chrome.rows[2]["childrenOmitted"] as? String, "chrome scope")
        let window = try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window")
        XCTAssertEqual(window.rows.count, 4)
        XCTAssertNil(window.rows[2]["childrenOmitted"])
    }

    func testWindowButtonsAreLeaves() throws {
        let fake = source()
        fake.nodes[2] = FakeNode(role: "AXButton", subrole: "AXCloseButton", children: [4])
        let tree = try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window")
        XCTAssertEqual(tree.rows.map { $0["role"] as? String }, ["AXWindow", "AXButton", "AXGroup", "AXStaticText"])
        XCTAssertEqual(tree.rows[1]["AXSubrole"] as? String, "AXCloseButton")
    }

    func testScrollAreaNarrowsTheVisibilityClip() throws {
        let fake = source()
        fake.nodes[3] = FakeNode(role: "AXScrollArea", children: [4], frame: CGRect(x: 0, y: 100, width: 400, height: 50))
        fake.nodes[4]?.frame = CGRect(x: 20, y: 200, width: 60, height: 20)
        let tree = try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window")
        XCTAssertEqual(tree.rows[3]["visible"] as? Bool, false, "scrolled out of the scroll area is not visible")
        fake.nodes[3]?.role = "AXGroup"
        let plain = try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window")
        XCTAssertEqual(plain.rows[3]["visible"] as? Bool, true, "a plain group does not clip")
    }

    func testSelectedTextRangeAndUnreadableValues() throws {
        let fake = source()
        var range = CFRange(location: 3, length: 4)
        fake.nodes[4]?.attributes = ["AXValue": NSObject(), "AXSelectedTextRange": AXValueCreate(.cfRange, &range) as Any]
        let tree = try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window")
        XCTAssertEqual(tree.rows[3]["AXSelectedTextRange"] as? String, "3:4")
        XCTAssertEqual(tree.rows[3]["AXValueReadable"] as? Bool, false)
        XCTAssertNil(tree.rows[3]["AXValue"])
    }

    func testChildrenReadFailurePropagates() {
        let fake = source()
        fake.nodes[3]?.childrenError = .cannotComplete
        XCTAssertThrowsError(try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window"))
    }

    func testElementLimitIsRefused() {
        let fake = FakeSource()
        var children: [pid_t] = []
        for pid in 2...pid_t(observedElementLimit + 1) {
            fake.nodes[pid] = FakeNode(role: "AXGroup")
            children.append(pid)
        }
        fake.nodes[1] = FakeNode(role: "AXWindow", children: children)
        XCTAssertThrowsError(try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window")) { error in
            XCTAssertEqual((error as? ObservedTreeError)?.message, "AX tree exceeds \(observedElementLimit) elements; snapshot refused rather than truncated")
        }
    }

    /// A sheet listing thousands of files made each read slow enough that the walk outlived the
    /// caller's deadline and was killed with the dispatched result. The deadline now stops the walk
    /// itself, with an error that says how far it got, and never with a partial tree.
    func testCallerDeadlineStopsTheWalkWithoutAPartialTree() {
        let fake = FakeSource()
        var children: [pid_t] = []
        for pid in 2...pid_t(40) {
            fake.nodes[pid] = FakeNode(role: "AXGroup")
            children.append(pid)
        }
        fake.nodes[1] = FakeNode(role: "AXWindow", children: children)
        var checks = 0
        XCTAssertThrowsError(try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window",
                                                   expired: { checks += 1; return checks > 10 })) { error in
            XCTAssertEqual((error as? ObservedTreeError)?.message, observationBudgetMessage(walked: 10))
        }
        XCTAssertNoThrow(try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window",
                                               expired: { false }))
    }
}

final class BulkHierarchySourceTests: XCTestCase {
    private let keys = BulkHierarchyKeys(
        arrayAttributes: "AXCHAA", maxArrayCount: "AXCHMAC", maxDepth: "AXCHMD",
        returnAttributeErrors: "AXCHRE", incomplete: "incmplt", count: "count", error: "error", value: "value"
    )

    private func axError(_ code: AXError) -> AXValue {
        var value = code
        return AXValueCreate(.axError, &value)!
    }

    /// An `NSDictionary` literal copies its keys and a CF element cannot be copied; the real
    /// result uses CF type callbacks, which retain. Build the fixture the same way.
    private func hierarchy(_ entries: [(AXUIElement, [String: Any])]) -> CFDictionary {
        var keyCallbacks = kCFTypeDictionaryKeyCallBacks
        var valueCallbacks = kCFTypeDictionaryValueCallBacks
        let dictionary = CFDictionaryCreateMutable(nil, 0, &keyCallbacks, &valueCallbacks)!
        for (element, attributes) in entries {
            let value = attributes as CFDictionary
            CFDictionarySetValue(dictionary, Unmanaged.passUnretained(element).toOpaque(), Unmanaged.passUnretained(value).toOpaque())
        }
        return dictionary
    }

    func testReadsValuesAndTreatsErrorsAsAbsent() throws {
        let root = AXUIElementCreateApplication(11)
        let child = AXUIElementCreateApplication(12)
        let dictionary = hierarchy([
            (root, [
                "AXRole": ["value": "AXWindow"],
                "AXTitle": ["error": axError(.attributeUnsupported)],
                "AXChildren": ["count": 1, "value": [child]],
            ]),
            (child, [
                "AXRole": ["value": "AXButton"],
                "AXChildren": ["error": axError(.noValue)],
            ]),
        ])
        let source = BulkHierarchySource(dictionary: dictionary, keys: keys)
        XCTAssertEqual(source.attribute(root, "AXRole") as? String, "AXWindow")
        XCTAssertNil(source.attribute(root, "AXTitle"))
        XCTAssertNil(source.attribute(root, "AXValue"), "an attribute the read did not return is absent")
        XCTAssertEqual(try source.children(of: root).count, 1)
        XCTAssertEqual(try source.children(of: child).count, 0, "unsupported/noValue children mean a leaf")
    }

    func testStructuralGapsThrowBulkErrorsSoTheWalkCanTakeOver() {
        let root = AXUIElementCreateApplication(21)
        let stranger = AXUIElementCreateApplication(22)
        let dictionary = hierarchy([
            (root, ["AXRole": ["value": "AXWindow"], "AXChildren": ["count": 1, "value": [stranger], "incmplt": true]]),
        ])
        let source = BulkHierarchySource(dictionary: dictionary, keys: keys)
        XCTAssertThrowsError(try source.children(of: root)) { error in
            guard case BulkHierarchyError.truncated = error else { return XCTFail("expected truncated, got \(error)") }
        }
        XCTAssertThrowsError(try source.children(of: stranger)) { error in
            guard case BulkHierarchyError.missingElement = error else { return XCTFail("expected missingElement, got \(error)") }
        }
    }

    func testARealChildrenFailureIsNotSwallowed() {
        let root = AXUIElementCreateApplication(31)
        let dictionary = hierarchy([(root, ["AXRole": ["value": "AXWindow"], "AXChildren": ["error": axError(.cannotComplete)]])])
        let source = BulkHierarchySource(dictionary: dictionary, keys: keys)
        XCTAssertThrowsError(try source.children(of: root)) { error in
            guard case BulkHierarchyError.failed(let code) = error, code == .cannotComplete else {
                return XCTFail("expected failed(cannotComplete), got \(error)")
            }
        }
    }

    func testTheReaderResolvesEveryKeyFromTheFrameworkOnThisMac() throws {
        // The reader wraps a private API. Where it is absent the workflow uses
        // LiveHierarchySource instead, so this is a capability check, not a contract: a machine
        // without the API skips it rather than failing a test about code it never runs.
        guard let reader = BulkHierarchyReader() else {
            throw XCTSkip("AXUIElementCopyHierarchy is unavailable here; the workflow falls back to LiveHierarchySource")
        }
        XCTAssertEqual(reader.keys.value, "value")
        XCTAssertEqual(reader.keys.incomplete, "incmplt")
        XCTAssertEqual(reader.keys.maxDepth, "AXCHMD")
    }
}

/// A page far over the 4000-row snapshot limit, with one button deep inside it.
final class QueryTreeTests: XCTestCase {
    private func bigPage(rows: Int = 5000) -> FakeSource {
        let fake = FakeSource()
        let listRows = (0..<rows).map { pid_t(100 + $0) }
        for pid in listRows {
            fake.nodes[pid] = FakeNode(role: "AXStaticText", attributes: ["AXValue": "file \(pid)"],
                                       frame: CGRect(x: 0, y: 0, width: 100, height: 10))
        }
        fake.nodes[1] = FakeNode(role: "AXWindow", attributes: ["AXTitle": "PR"], children: [2, 3],
                                 frame: CGRect(x: 0, y: 0, width: 1000, height: 800))
        fake.nodes[2] = FakeNode(role: "AXGroup", children: listRows, frame: CGRect(x: 0, y: 0, width: 1000, height: 700))
        fake.nodes[3] = FakeNode(role: "AXToolbar", children: [4, 5], frame: CGRect(x: 0, y: 700, width: 1000, height: 100))
        fake.nodes[4] = FakeNode(role: "AXButton", attributes: ["AXTitle": "Review with agent"], actions: ["AXPress"],
                                 frame: CGRect(x: 10, y: 710, width: 120, height: 30))
        fake.nodes[5] = FakeNode(role: "AXStaticText", attributes: ["AXValue": "Review with agent"],
                                 frame: CGRect(x: 140, y: 710, width: 120, height: 30))
        return fake
    }

    func testWholeWindowIsRefusedButTheQueryKeepsOnlyMatchesAndAncestors() throws {
        let fake = bigPage()
        XCTAssertThrowsError(try buildObservedTree(root: fake.element(1), source: fake, depth: 10, scope: "window"))
        let result = try buildQueryTree(root: fake.element(1), source: fake, depth: 10,
                                        query: TreeQuery(text: "review with AGENT", role: "AXButton"))
        XCTAssertEqual(result.tree.rows.map { $0["role"] as? String }, ["AXWindow", "AXToolbar", "AXButton"])
        XCTAssertEqual(result.report.matches, 1)
        XCTAssertEqual(result.report.walked, 5005)
        XCTAssertEqual(result.report.depthLimitedSubtrees, 0)
        XCTAssertEqual(result.tree.rows.last?["actions"] as? [String], ["AXPress"])
    }

    /// `act` re-walks the same query, so the rows, indexes and digest must be the same every time.
    func testTheSameQueryYieldsTheSameDigest() throws {
        let fake = bigPage()
        let query = TreeQuery(text: "Review with agent", role: nil)
        let first = try buildQueryTree(root: fake.element(1), source: fake, depth: 10, query: query)
        let second = try buildQueryTree(root: fake.element(1), source: fake, depth: 10, query: query)
        XCTAssertEqual(first.tree.digest, second.tree.digest)
        XCTAssertEqual(first.report.matches, 2)
        XCTAssertEqual(first.tree.rows.count, 4)
    }

    /// Never silently partial: what the depth limit hid is counted and reported.
    func testSubtreesBelowTheDepthLimitAreReportedNotHidden() throws {
        let fake = bigPage(rows: 3)
        let result = try buildQueryTree(root: fake.element(1), source: fake, depth: 1,
                                        query: TreeQuery(text: "Review", role: "AXButton"))
        XCTAssertEqual(result.report.matches, 0)
        XCTAssertEqual(result.report.depthLimitedSubtrees, 2)
        XCTAssertEqual(result.tree.rows.count, 1)
    }

    func testTooManyMatchesAreRefused() {
        let fake = bigPage(rows: 300)
        XCTAssertThrowsError(try buildQueryTree(root: fake.element(1), source: fake, depth: 10,
                                                query: TreeQuery(text: "file", role: nil))) { error in
            XCTAssertEqual((error as? ObservedTreeError)?.message,
                           "query matches more than \(queryMatchLimit) elements; narrow it with a role or a longer query")
        }
    }

    func testQueryTokensRoundTripAndValidate() throws {
        let token = SnapshotToken(pid: 7, launch: 1, window: 3, depth: 50, digest: "d", created: 100, scope: "query",
                                  query: TreeQuery(text: "Review with agent", role: "AXButton"))
        let decoded = try JSONDecoder().decode(SnapshotToken.self, from: JSONEncoder().encode(token))
        XCTAssertEqual(decoded.query, TreeQuery(text: "Review with agent", role: "AXButton"))
        XCTAssertEqual(try decoded.validate(pid: 7, launch: 1, window: 3, digest: "d", element: 0, count: 3, now: 101), 0)
        let bare = SnapshotToken(pid: 7, launch: 1, window: 3, depth: 50, digest: "d", created: 100, scope: "query")
        XCTAssertThrowsError(try bare.validate(pid: 7, launch: 1, window: 3, digest: "d", element: 0, count: 3, now: 101))
    }
}

extension QueryTreeTests {
    /// Without the sheet in the rows, the modal barrier could not see it, and a query result would
    /// let a click through to a button a file panel covers.
    func testAModalSheetElsewhereIsKeptSoTheBarrierStillRefuses() throws {
        let fake = FakeSource()
        fake.nodes[1] = FakeNode(role: "AXWindow", children: [2, 3], frame: CGRect(x: 0, y: 0, width: 1000, height: 800))
        fake.nodes[2] = FakeNode(role: "AXSheet", children: [4], frame: CGRect(x: 200, y: 50, width: 600, height: 400))
        fake.nodes[4] = FakeNode(role: "AXButton", attributes: ["AXTitle": "Open"], actions: ["AXPress"],
                                 frame: CGRect(x: 600, y: 400, width: 80, height: 30))
        fake.nodes[3] = FakeNode(role: "AXButton", attributes: ["AXTitle": "Load unpacked"], actions: ["AXPress"],
                                 frame: CGRect(x: 10, y: 10, width: 120, height: 30))
        let result = try buildQueryTree(root: fake.element(1), source: fake, depth: 10,
                                        query: TreeQuery(text: "Load unpacked", role: "AXButton"))
        XCTAssertEqual(result.tree.rows.map { $0["role"] as? String }, ["AXWindow", "AXSheet", "AXButton"])
        let target = try XCTUnwrap(result.tree.rows.firstIndex { $0["AXTitle"] as? String == "Load unpacked" })
        XCTAssertThrowsError(try validateModalTarget(rows: result.tree.rows, target: target))
    }
}

/// chrome://extensions: one card per extension, each with a heading and an identical "Reload"
/// button whose parent holds no text, so every key the builder computes is the same for all.
final class IdenticalTargetTests: XCTestCase {
    private func extensionsPage(cards: [String]) -> FakeSource {
        let fake = FakeSource()
        var cardPids: [pid_t] = []
        for (offset, name) in cards.enumerated() {
            let base = pid_t(10 + offset * 10)
            fake.nodes[base] = FakeNode(role: "AXGroup", children: [base + 1, base + 2],
                                        frame: CGRect(x: 0, y: Double(offset) * 200, width: 400, height: 190))
            fake.nodes[base + 1] = FakeNode(role: "AXHeading", attributes: ["AXTitle": name],
                                            frame: CGRect(x: 10, y: Double(offset) * 200 + 5, width: 200, height: 20))
            fake.nodes[base + 2] = FakeNode(role: "AXGroup", children: [base + 3],
                                            frame: CGRect(x: 0, y: Double(offset) * 200 + 150, width: 400, height: 40))
            fake.nodes[base + 3] = FakeNode(role: "AXButton", attributes: ["AXDescription": "Reload"],
                                            actions: ["AXScrollToVisible", "AXShowMenu"],
                                            frame: CGRect(x: 300, y: Double(offset) * 200 + 155, width: 30, height: 30))
            cardPids.append(base)
        }
        fake.nodes[1] = FakeNode(role: "AXWindow", children: [2], frame: CGRect(x: 0, y: 0, width: 400, height: 900))
        fake.nodes[2] = FakeNode(role: "AXWebArea", attributes: ["AXURL": URL(string: "chrome://extensions/")!],
                                 children: cardPids, frame: CGRect(x: 0, y: 0, width: 400, height: 900))
        return fake
    }

    private func reloads(_ tree: ObservedTreeData) -> [Int] {
        tree.rows.indices.filter { tree.rows[$0]["AXDescription"] as? String == "Reload" }
    }

    func testAnExactRefToOneOfSeveralIdenticalButtonsResolvesToThatButton() throws {
        let fake = extensionsPage(cards: ["GenesisTools", "7TV", "AdBlock"])
        let tree = try buildObservedTree(root: fake.element(1), source: fake, depth: 10, scope: "window")
        let buttons = reloads(tree)
        let key = try XCTUnwrap(tree.rows[buttons[1]]["stableKey"] as? String)
        XCTAssertEqual(Set(buttons.map { tree.rows[$0]["stableKey"] as? String }).count, 1, "the fixture must reproduce the shared key")
        XCTAssertThrowsError(try resolvedTargetIndex(key: key, rows: tree.rows))
        let ordinal = try XCTUnwrap(TargetOrdinal.of(buttons[1], rows: tree.rows, field: "stableKey"))
        XCTAssertEqual(ordinal, TargetOrdinal(position: 1, count: 3))
        let fresh = try buildObservedTree(root: fake.element(1), source: fake, depth: 10, scope: "window")
        XCTAssertEqual(try resolvedTargetIndex(key: key, rows: fresh.rows, ordinal: ordinal), buttons[1])
    }

    /// One card fewer shifts which button is "second"; that must refuse, not press a neighbour.
    func testAChangedNumberOfTwinsStillRefuses() throws {
        let observed = try buildObservedTree(root: extensionsPage(cards: ["GenesisTools", "7TV", "AdBlock"]).element(1),
                                             source: extensionsPage(cards: ["GenesisTools", "7TV", "AdBlock"]), depth: 10, scope: "window")
        let button = reloads(observed)[2]
        let key = try XCTUnwrap(observed.rows[button]["stableKey"] as? String)
        let ordinal = try XCTUnwrap(TargetOrdinal.of(button, rows: observed.rows, field: "stableKey"))
        let smaller = extensionsPage(cards: ["GenesisTools", "7TV"])
        let fresh = try buildObservedTree(root: smaller.element(1), source: smaller, depth: 10, scope: "window")
        XCTAssertThrowsError(try resolvedTargetIndex(key: key, rows: fresh.rows, ordinal: ordinal)) { error in
            XCTAssertTrue(error.localizedDescription.contains("3 identical elements were observed and 2 are present now"),
                          error.localizedDescription)
        }
    }

    func testOrdinalArgumentsAreParsedStrictly() {
        XCTAssertEqual(TargetOrdinal("1/3"), TargetOrdinal(position: 1, count: 3))
        for invalid in ["3/3", "0/1", "-1/3", "a/3", "1/", "01/3", "1/3/4"] {
            XCTAssertNil(TargetOrdinal(invalid), invalid)
        }
    }
}

/// Brave's tab strip labels carry a live memory figure; the page beside them does not move.
final class DocumentScopeTests: XCTestCase {
    private func browser(tabs: [String], button: String = "Reload") -> FakeSource {
        let fake = FakeSource()
        let tabPids = tabs.indices.map { pid_t(100 + $0) }
        for (offset, label) in tabs.enumerated() {
            fake.nodes[tabPids[offset]] = FakeNode(role: "AXRadioButton", attributes: ["AXTitle": label],
                                                   frame: CGRect(x: Double(offset) * 100, y: 0, width: 100, height: 30))
        }
        fake.nodes[1] = FakeNode(role: "AXWindow", children: [2, 3], frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        fake.nodes[2] = FakeNode(role: "AXTabGroup", children: tabPids, frame: CGRect(x: 0, y: 0, width: 800, height: 30))
        fake.nodes[3] = FakeNode(role: "AXWebArea", attributes: ["AXURL": URL(string: "chrome://extensions/")!],
                                 children: [4], frame: CGRect(x: 0, y: 40, width: 800, height: 560))
        fake.nodes[4] = FakeNode(role: "AXGroup", children: [5], frame: CGRect(x: 0, y: 40, width: 800, height: 200))
        fake.nodes[5] = FakeNode(role: "AXButton", attributes: ["AXDescription": button], actions: ["AXShowMenu"],
                                 frame: CGRect(x: 10, y: 50, width: 60, height: 30))
        return fake
    }

    private func tree(_ fake: FakeSource) throws -> ObservedTreeData {
        try buildObservedTree(root: fake.element(1), source: fake, depth: 10, scope: "window")
    }

    private func button(_ tree: ObservedTreeData) -> Int {
        tree.rows.firstIndex { $0["role"] as? String == "AXButton" }!
    }

    func testOnlyATabLabelChangedSoThePageTargetIsStillActionable() throws {
        let observed = try tree(browser(tabs: ["Extensions - Memory usage - 166 MB"]))
        let current = try tree(browser(tabs: ["Extensions - Memory usage - 171 MB"]))
        XCTAssertNotEqual(observed.digest, current.digest, "the whole-window digest refused this before")
        XCTAssertEqual(remapDocumentTarget(observedIndex: button(observed), observed: try documentScope(observed.rows),
                                           current: try documentScope(current.rows)), button(current))
    }

    func testANewTabShiftsTheIndexAndTheTargetFollows() throws {
        let observed = try tree(browser(tabs: ["Extensions"]))
        let current = try tree(browser(tabs: ["Extensions", "New Tab"]))
        XCTAssertEqual(remapDocumentTarget(observedIndex: button(observed), observed: try documentScope(observed.rows),
                                           current: try documentScope(current.rows)), button(observed) + 1)
    }

    func testAChangedPageOrAChromeTargetStillRefuses() throws {
        let observed = try tree(browser(tabs: ["Extensions"]))
        let relabelled = try tree(browser(tabs: ["Extensions"], button: "Remove"))
        XCTAssertNil(remapDocumentTarget(observedIndex: button(observed), observed: try documentScope(observed.rows),
                                         current: try documentScope(relabelled.rows)))
        let tab = observed.rows.firstIndex { $0["role"] as? String == "AXRadioButton" }!
        let churned = try tree(browser(tabs: ["Extensions - 170 MB"]))
        XCTAssertNil(remapDocumentTarget(observedIndex: tab, observed: try documentScope(observed.rows),
                                         current: try documentScope(churned.rows)))
    }
}
