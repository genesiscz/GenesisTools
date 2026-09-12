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

    func testSharedChildIsVisitedOnce() throws {
        let fake = source()
        fake.nodes[3]?.children = [4, 4]
        fake.nodes[1]?.children = [2, 3, 4]
        let tree = try buildObservedTree(root: fake.element(1), source: fake, depth: 5, scope: "window")
        XCTAssertEqual(tree.rows.count, 4)
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
            (root, ["AXChildren": ["count": 1, "value": [stranger], "incmplt": true]]),
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
        let dictionary = hierarchy([(root, ["AXChildren": ["error": axError(.cannotComplete)]])])
        let source = BulkHierarchySource(dictionary: dictionary, keys: keys)
        XCTAssertThrowsError(try source.children(of: root)) { error in
            guard case BulkHierarchyError.failed(let code) = error, code == .cannotComplete else {
                return XCTFail("expected failed(cannotComplete), got \(error)")
            }
        }
    }

    func testTheReaderResolvesEveryKeyFromTheFrameworkOnThisMac() throws {
        let reader = try XCTUnwrap(BulkHierarchyReader(), "AXUIElementCopyHierarchy is expected on this machine")
        XCTAssertEqual(reader.keys.value, "value")
        XCTAssertEqual(reader.keys.incomplete, "incmplt")
        XCTAssertEqual(reader.keys.maxDepth, "AXCHMD")
    }
}
