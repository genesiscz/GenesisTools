import CoreGraphics
import XCTest
@testable import SnapshotSupport

/// The occlusion refusal names what is really at the point (handoff h_00ddcbx1 t26).
final class PointOwnerTests: XCTestCase {
    private let terminal = ListedWindow(id: 11, ownerPid: 501, ownerName: "cmux", title: "work", layer: 0,
                                        bounds: CGRect(x: 0, y: 30, width: 1000, height: 800))
    private let target = ListedWindow(id: 22, ownerPid: 77, ownerName: "Fixture", title: "Doc", layer: 0,
                                      bounds: CGRect(x: 100, y: 100, width: 400, height: 300))
    private let menuBar = ListedWindow(id: 1, ownerPid: 9, ownerName: "Window Server", title: "Menubar", layer: 24,
                                       bounds: CGRect(x: 0, y: 0, width: 2000, height: 30))

    func testTheFrontmostNormalWindowHoldingThePointOwnsIt() {
        XCTAssertEqual(windowOwningPoint(CGPoint(x: 200, y: 200), in: [menuBar, terminal, target]), terminal)
        XCTAssertEqual(windowOwningPoint(CGPoint(x: 200, y: 200), in: [target, terminal]), target)
        XCTAssertNil(windowOwningPoint(CGPoint(x: 5, y: 5), in: [menuBar]), "other layers never own a click")
    }

    func testTheRefusalNamesTheCoveringAppWindowAndTheHit() {
        let hit = HitElement(app: "cmux", pid: 501, role: "AXTextArea", label: "terminal")
        let text = occlusionRefusal(point: CGPoint(x: 200.4, y: 199.6), targetPid: 77, targetWindowId: 22,
                                    owner: terminal, hit: hit)
        XCTAssertTrue(text.hasPrefix("observed target is occluded or hit testing disagrees; no event dispatched."))
        XCTAssertTrue(text.contains("At (200, 200) the top window is cmux \"work\" (window 11, pid 501), another app."))
        XCTAssertTrue(text.contains("The hit test returned AXTextArea \"terminal\" of cmux."))
    }

    func testTheTargetWindowItselfAndASiblingWindowAreToldApart() {
        let own = occlusionRefusal(point: CGPoint(x: 150, y: 150), targetPid: 77, targetWindowId: 22, owner: target, hit: nil)
        XCTAssertTrue(own.contains("the target window itself"))
        let sibling = ListedWindow(id: 23, ownerPid: 77, ownerName: "Fixture", title: nil, layer: 0, bounds: target.bounds)
        let other = occlusionRefusal(point: CGPoint(x: 150, y: 150), targetPid: 77, targetWindowId: 22, owner: sibling, hit: nil)
        XCTAssertTrue(other.contains("Fixture (window 23, pid 77), another window of the target app."))
    }

    func testNoListedWindowIsSaidPlainly() {
        let text = occlusionRefusal(point: CGPoint(x: 1, y: 1), targetPid: 77, targetWindowId: 22, owner: nil, hit: nil)
        XCTAssertTrue(text.contains("the window server lists no normal window"))
    }
}
