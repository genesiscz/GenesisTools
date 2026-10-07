import AppKit
import SwiftUI

/// The window a view is in, held without SwiftUI state: setting it re-renders nothing. A session screen
/// uses it to pause its live tail while its own window is minimized.
public final class HostWindow {
    public weak var window: NSWindow?

    public init() {}
}

/// Records the window its view moves into, once per move (not per update). Put it in a `.background`.
public struct HostWindowReader: NSViewRepresentable {
    let host: HostWindow

    public init(host: HostWindow) {
        self.host = host
    }

    public final class Probe: NSView {
        var host: HostWindow?

        override public func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            host?.window = window
        }
    }

    public func makeNSView(context: Context) -> Probe {
        let probe = Probe()
        probe.host = host
        return probe
    }

    public func updateNSView(_ view: Probe, context: Context) {
        view.host = host
    }
}
