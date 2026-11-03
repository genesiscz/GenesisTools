// A deterministic scene for recorder-benchmark.ts: one small borderless panel in the bottom-right corner of every
// display, which flips its colour and shows the next number every 2 s. It never takes focus (an accessory app with
// non-activating panels that ignore the mouse). Each change prints {"event":"change","n":N,"at":<epoch ms>} on stdout.
import AppKit

let interval = Double(CommandLine.arguments.dropFirst().first ?? "2") ?? 2
let size = NSSize(width: 360, height: 180)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

final class Scene {
    var panels: [(NSPanel, NSTextField)] = []
    var n = 0

    init() {
        for screen in NSScreen.screens {
            let frame = screen.visibleFrame
            let rect = NSRect(x: frame.maxX - size.width - 8, y: frame.minY + 8, width: size.width, height: size.height)
            let panel = NSPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.level = .floating
            panel.ignoresMouseEvents = true
            panel.hidesOnDeactivate = false
            panel.collectionBehavior = [.canJoinAllSpaces, .stationary]
            let label = NSTextField(labelWithString: "0")
            label.font = NSFont.monospacedDigitSystemFont(ofSize: 120, weight: .black)
            label.alignment = .center
            label.frame = NSRect(origin: .zero, size: size)
            panel.contentView?.addSubview(label)
            panel.contentView?.wantsLayer = true
            panel.orderFrontRegardless()
            panels.append((panel, label))
        }
    }

    func step() {
        n += 1
        let dark = n % 2 == 0
        for (panel, label) in panels {
            panel.contentView?.layer?.backgroundColor = (dark ? NSColor.black : NSColor.white).cgColor
            label.textColor = dark ? .white : .black
            label.stringValue = String(n % 1000)
            panel.display()
        }
        let at = Int((Date().timeIntervalSince1970 * 1000).rounded())
        print("{\"event\":\"change\",\"n\":\(n),\"at\":\(at)}")
        fflush(stdout)
    }
}

let scene = Scene()
print("{\"event\":\"ready\",\"displays\":\(scene.panels.count)}")
fflush(stdout)
Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { _ in scene.step() }
signal(SIGTERM) { _ in exit(0) }
app.run()
