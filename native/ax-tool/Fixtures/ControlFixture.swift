import AppKit

final class FlippedContent: NSView {
    override var isFlipped: Bool { true }
}

final class FixtureButton: NSButton {
    var secondary: (() -> Void)?
    override func rightMouseDown(with event: NSEvent) { secondary?() }
}

final class DragSurface: NSView {
    var status: NSTextField?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { status?.stringValue = "down" }
    override func mouseDragged(with event: NSEvent) { status?.stringValue = "dragging" }
    override func mouseUp(with event: NSEvent) {
        if status?.stringValue == "dragging" { status?.stringValue = "dragged" }
    }
}

/// Depth of the opt-in "Deep" window, or nil when it must not be built at all.
///
/// Opt-in on purpose: `src/control/scripts/live-smoke.ts` asserts this fixture shows exactly two
/// windows, so a third one may only appear when a caller asks for it. The benchmark that asks is
/// `scripts/benchmarks/swift/ax-tool-depth.ts`, which measures an `--id` lookup against a known
/// hierarchy depth.
///
/// The command-line form wins over the environment form because `open(1)` launches through
/// LaunchServices, which does not promise to forward the caller's environment.
func deepWindowDepth() -> (depth: Int, source: String)? {
    let arguments = CommandLine.arguments

    if let flag = arguments.firstIndex(of: "--deep-depth"), flag + 1 < arguments.count,
       let parsed = Int(arguments[flag + 1]), parsed > 0 {
        return (parsed, "arg")
    }

    if let raw = ProcessInfo.processInfo.environment["CONTROL_FIXTURE_DEEP_DEPTH"],
       let parsed = Int(raw), parsed > 0 {
        return (parsed, "env")
    }

    if arguments.contains("--deep") {
        return (60, "default")
    }

    return nil
}

final class CanvasSwatch: NSView {
    var alternate = false
    override func draw(_ dirtyRect: NSRect) {
        (alternate ? NSColor.systemOrange : NSColor.systemPurple).setFill()
        NSBezierPath(rect: bounds).fill()
    }
}

final class ControlFixture: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []
    var counters: [NSTextField] = []
    var swatches: [Int: CanvasSwatch] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "Edit")
        edit.addItem(NSMenuItem(title: "Select All", action: Selector(("selectAll:")), keyEquivalent: "a"))
        edit.addItem(NSMenuItem(title: "Paste", action: Selector(("paste:")), keyEquivalent: "v"))
        editItem.submenu = edit
        menu.addItem(editItem)
        NSApp.mainMenu = menu
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        for index in 0..<2 {
            let window = NSWindow(contentRect: NSRect(x: screen.minX + 40 + CGFloat(index) * 380,
                                                      y: screen.minY + 80, width: 350, height: 420),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Control fixture"
            window.isReleasedWhenClosed = false
            let content = window.contentView!
            let counter = NSTextField(labelWithString: "0")
            counter.frame = NSRect(x: 20, y: 370, width: 280, height: 24)
            counter.setAccessibilityIdentifier("counter")
            content.addSubview(counter)
            counters.append(counter)
            if CommandLine.arguments.contains("--visual") {
                let canvas = CanvasSwatch(frame: NSRect(x: 150, y: 374, width: 35, height: 18))
                canvas.setAccessibilityElement(false)
                content.addSubview(canvas)
                swatches[index] = canvas
                let paint = NSButton(title: "Paint", target: self, action: #selector(paintCanvas(_:)))
                paint.tag = index
                paint.frame = NSRect(x: 200, y: 370, width: 100, height: 26)
                paint.setAccessibilityIdentifier("paint")
                content.addSubview(paint)
            }
            for buttonIndex in 0..<2 {
                let button = FixtureButton(title: "Increment", target: self, action: #selector(increment(_:)))
                button.secondary = { counter.stringValue = String((Int(counter.stringValue) ?? 0) + 100) }
                button.tag = index * 10 + buttonIndex
                button.frame = NSRect(x: 20 + buttonIndex * 150, y: 315, width: 130, height: 32)
                content.addSubview(button)
            }
            let field = NSTextField(string: "seed")
            field.frame = NSRect(x: 20, y: 265, width: 290, height: 26)
            field.setAccessibilityIdentifier("input")
            content.addSubview(field)
            if CommandLine.arguments.contains("--semantic") {
                let toggle = NSButton(checkboxWithTitle: "Show line numbers", target: nil, action: nil)
                toggle.frame = NSRect(x: 20, y: 240, width: 290, height: 22)
                toggle.setAccessibilityIdentifier("line-numbers")
                content.addSubview(toggle)
            }
            if CommandLine.arguments.contains("--cursor-proof"), index == 0 {
                let proof = NSButton(checkboxWithTitle: "Cursor proof", target: nil, action: nil)
                proof.frame = NSRect(x: 20, y: 240, width: 130, height: 22)
                proof.setAccessibilityIdentifier("cursor-proof")
                content.addSubview(proof)
                let proofInput = NSTextField(string: "")
                proofInput.frame = NSRect(x: 170, y: 237, width: 145, height: 26)
                proofInput.setAccessibilityIdentifier("cursor-proof-input")
                content.addSubview(proofInput)
            }
            let disabled = NSButton(title: "Disabled", target: self, action: #selector(increment(_:)))
            disabled.isEnabled = false
            disabled.frame = NSRect(x: 20, y: 210, width: 130, height: 32)
            content.addSubview(disabled)
            let dragStatus = NSTextField(labelWithString: "idle")
            dragStatus.frame = NSRect(x: 170, y: 185, width: 150, height: 22)
            dragStatus.setAccessibilityIdentifier("dragStatus")
            content.addSubview(dragStatus)
            let drag = DragSurface(frame: NSRect(x: 170, y: 210, width: 140, height: 32))
            drag.setAccessibilityElement(true)
            drag.setAccessibilityRole(.group)
            drag.setAccessibilityLabel("Drag surface")
            drag.setAccessibilityIdentifier("drag")
            drag.wantsLayer = true
            drag.layer?.backgroundColor = NSColor.systemBlue.cgColor
            drag.status = dragStatus
            content.addSubview(drag)
            let scroll = NSScrollView(frame: NSRect(x: 20, y: 20, width: 300, height: 160))
            scroll.hasVerticalScroller = true
            scroll.setAccessibilityIdentifier("scroll")
            let document = FlippedContent(frame: NSRect(x: 0, y: 0, width: 280, height: 600))
            for row in 0..<15 {
                let label = NSTextField(labelWithString: "Row \(row)")
                label.frame = NSRect(x: 5, y: row * 30, width: 200, height: 24)
                document.addSubview(label)
            }
            let offscreen = NSButton(title: "Offscreen", target: self, action: #selector(increment(_:)))
            offscreen.tag = index * 10
            offscreen.frame = NSRect(x: 5, y: 500, width: 130, height: 32)
            document.addSubview(offscreen)
            scroll.documentView = document
            content.addSubview(scroll)
            windows.append(window)
            if CommandLine.arguments.contains("--background") {
                window.orderFrontRegardless()
            } else {
                window.makeKeyAndOrderFront(nil)
            }
        }
        let deep = deepWindowDepth()

        if let deep {
            let window = makeDeepWindow(depth: deep.depth, screen: screen)
            windows.append(window)

            if CommandLine.arguments.contains("--background") {
                window.orderFrontRegardless()
            } else {
                window.makeKeyAndOrderFront(nil)
            }
        }

        if !CommandLine.arguments.contains("--background") {
            NSApp.activate(ignoringOtherApps: true)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            let suffix = deep.map { " deep:\($0.depth) deepSource:\($0.source)" } ?? ""
            print("ready:\(ProcessInfo.processInfo.processIdentifier)\(suffix)")
            fflush(stdout)
        }
    }

    /// A chain of `depth` nested `NSBox`es with one button at the bottom, identified `deep-leaf`.
    ///
    /// Every box carries `deep-<level>` so the real accessibility depth of the leaf can be read
    /// back rather than assumed: AppKit decides how many accessibility levels one `NSBox` becomes,
    /// and that number is what the depth cap in `findByIdentifier` counts.
    ///
    /// All boxes share one frame instead of insetting, so a 60-level chain still has a visible,
    /// non-degenerate leaf; an element accessibility reports as zero-sized is a different test.
    private func makeDeepWindow(depth: Int, screen: NSRect) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: screen.minX + 40 + 2 * 380, y: screen.minY + 80,
                                                  width: 320, height: 200),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Deep"
        window.isReleasedWhenClosed = false
        var parent = window.contentView!

        for level in 0..<depth {
            let box = NSBox(frame: NSRect(x: 0, y: 0, width: 320, height: 200))
            box.boxType = .custom
            box.titlePosition = .noTitle
            box.borderWidth = 0
            box.contentViewMargins = .zero
            box.setAccessibilityIdentifier("deep-\(level)")
            parent.addSubview(box)
            parent = box.contentView ?? box
        }

        // Inert on purpose: the benchmark only looks this button up, and an action here would let
        // a stray press change the counters the other two windows assert on.
        let leaf = NSButton(title: "Leaf", target: nil, action: nil)
        leaf.frame = NSRect(x: 20, y: 20, width: 130, height: 32)
        leaf.setAccessibilityIdentifier("deep-leaf")
        parent.addSubview(leaf)
        return window
    }

    @objc func paintCanvas(_ sender: NSButton) {
        let canvas = swatches[sender.tag]
        canvas?.alternate.toggle()
        canvas?.needsDisplay = true
        canvas?.displayIfNeeded()
    }

    @objc func increment(_ sender: NSButton) {
        let counter = counters[sender.tag / 10]
        counter.stringValue = String((Int(counter.stringValue) ?? 0) + (sender.tag % 10 == 0 ? 1 : 10))
    }
}

let app = NSApplication.shared
let delegate = ControlFixture()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
