import AppKit
import SwiftUI

/// What an app lends the kit: where its log lines go, how it opens a terminal, and how it renders
/// text a panel find can mark. Every member has a default, so an app implements only what it has.
///
/// The kit finds the host by class name, `GenesisKitHostAdapter` (declare it
/// `@objc(GenesisKitHostAdapter) final class …: NSObject, GenesisKitHost`), so no launch code has to
/// call anything. `GenesisKit.install(_:)` sets one explicitly (tests).
public protocol GenesisKitHost: AnyObject {
    /// One diagnostic line (GenesisTools: `HubPerf.log` into app-perf.log).
    func log(_ line: String)
    /// Whether "Open in a new cmux workspace" is offered for a path.
    var opensTerminal: Bool { get }
    /// Opens a shell in `folder`. Called on the main thread; the host moves slow work off it.
    func openTerminal(folder: String)
    /// Text a panel find can mark (GenesisTools: `FindText`); nil draws a plain `Text`.
    func findText(_ text: String, field: String) -> AnyView?
}

public extension GenesisKitHost {
    func log(_ line: String) {}
    var opensTerminal: Bool { false }
    func openTerminal(folder: String) {}
    func findText(_ text: String, field: String) -> AnyView? { nil }
}

public enum GenesisKit {
    nonisolated(unsafe) private static var installed: GenesisKitHost?
    nonisolated(unsafe) private static var looked = false
    private static let lock = NSLock()

    /// Sets the host by hand instead of the class-name lookup.
    public static func install(_ host: GenesisKitHost?) {
        lock.lock()
        defer { lock.unlock() }
        installed = host
        looked = true
    }

    /// The app's host, found once by class name; nil in an app that declares none.
    public static var host: GenesisKitHost? {
        lock.lock()
        defer { lock.unlock() }
        if !looked {
            looked = true
            if let type = NSClassFromString("GenesisKitHostAdapter") as? NSObject.Type {
                installed = type.init() as? GenesisKitHost
            }
        }
        return installed
    }

    /// Counts renders by name for an app's render tests (Genesis `RenderProbe.hit`); nil counts nothing.
    /// `LiveTime` reports "liveTime.tick" on every tick.
    nonisolated(unsafe) public static var renderProbe: ((String) -> Void)?

    static func log(_ line: String) {
        host?.log(line)
    }
}

/// A shown text that the host's panel find can mark, else a plain `Text`.
struct KitFindText: View {
    let text: String
    let field: String

    var body: some View {
        if let marked = GenesisKit.host?.findText(text, field: field) {
            marked
        } else {
            Text(verbatim: text)
        }
    }
}
