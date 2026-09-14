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

final class ControlFixture: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []
    var counters: [NSTextField] = []

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
        if !CommandLine.arguments.contains("--background") {
            NSApp.activate(ignoringOtherApps: true)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            print("ready:\(ProcessInfo.processInfo.processIdentifier)")
            fflush(stdout)
        }
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
