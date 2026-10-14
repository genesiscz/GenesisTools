import AppKit
import Darwin
import Foundation
import QuartzCore
import CoreVideo
import SnapshotSupport

private enum CursorChannel {
    static let directory = "/tmp/genesis-control-cursor-\(getuid())"
    static let socketPath = directory + "/events-v2.sock"
    static func prepare() -> Bool {
        do {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
        } catch {
            var info = stat()
            guard lstat(directory, &info) == 0, info.st_uid == getuid(),
                  (info.st_mode & S_IFMT) == S_IFDIR, (info.st_mode & 0o077) == 0 else {
                fputs("Cursor feedback directory unavailable: \(error.localizedDescription)\n", stderr)
                return false
            }
        }
        return true
    }
    static func address(filename: String = socketPath) -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(filename.utf8) + [0]
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: bytes) }
        return address
    }
    static func send(_ data: Data, filename: String = socketPath) -> Bool {
        let fd = socket(AF_UNIX, SOCK_DGRAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var address = address(filename: filename)
        return data.withUnsafeBytes { bytes in
            withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    sendto(fd, bytes.baseAddress, bytes.count, MSG_DONTWAIT, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == bytes.count
                }
            }
        }
    }
}

enum ActionCursor {
    /// Set when the target is a non-activating panel. Measured before the helper ran with the
    /// .prohibited policy: one of three coordinate clicks on such a panel left ax-tool frontmost
    /// with feedback on, none with it off. Kept until the same three clicks are measured again.
    static var suppressedForNonActivatingPanel = false
    /// What the label beside the cursor names. Set where a command resolves its target.
    private static var targetApp: String?
    private static var targetRole: String?
    private static var targetName: String?
    private static var targetSecure = false
    /// The line under the label: the text a set, paste or type writes, or the keys a key act sends.
    private static var detail: String?

    /// Names what this act writes, after `describe(_:)` has said whether the field is secure.
    static func describeInput(action: String, text: String?) {
        detail = CursorFeedbackText.detail(action: action, text: text, secure: targetSecure)
    }

    /// For an act sent to the window: the app's focused input receives it, so that input decides whether
    /// the label hides the text. Call after `describe(_:)` and before `describeInput`.
    static func describeRecipient(sentToWindow: Bool, focused: AXUIElement?) {
        let parts = focused.map { element in
            let role = recipientAttribute(element, "AXRole", absentAllowed: false)
            let subrole = recipientAttribute(element, "AXSubrole", absentAllowed: true)
            return (values: [role.value, subrole.value], failed: role.failed || subrole.failed)
        }
        targetSecure = CursorFeedbackText.writesToSecureField(targetSecure: targetSecure, sentToWindow: sentToWindow,
                                                              focused: parts?.values,
                                                              focusedReadFailed: parts?.failed ?? false)
    }

    /// An unsupported/no-value subrole is genuinely absent. Other AX errors, a missing role,
    /// or a successful read of a non-string leave the security classification unknown.
    private static func recipientAttribute(_ element: AXUIElement, _ name: String,
                                            absentAllowed: Bool) -> (value: String?, failed: Bool) {
        var raw: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, name as CFString, &raw)
        if status == .success, let value = raw as? String {
            return (value, false)
        }
        if absentAllowed, status == .attributeUnsupported || status == .noValue {
            return (nil, false)
        }
        return (nil, true)
    }

    /// Names the app a pointer-only act goes to, when no element is known.
    static func describe(pid: pid_t) {
        targetApp = NSRunningApplication(processIdentifier: pid)?.localizedName
    }

    /// Names the element an act goes to: its role and title, never its value, which can be a password.
    static func describe(_ element: AXUIElement) {
        var pid: pid_t = 0
        if AXUIElementGetPid(element, &pid) == .success {
            describe(pid: pid)
        }
        targetRole = axStringAttribute(element, "AXRole")
        targetName = [axStringAttribute(element, "AXTitle"), axStringAttribute(element, "AXDescription")]
            .compactMap { $0 }.first { !$0.isEmpty }
        targetSecure = [targetRole, axStringAttribute(element, "AXSubrole")].contains("AXSecureTextField")
    }
    static var enabled: Bool {
        !suppressedForNonActivatingPanel
            && cursorFeedbackEnabled(arguments: CommandLine.arguments,
                                     environment: ProcessInfo.processInfo.environment)
    }
    static func emit(_ verb: String, point: CGPoint?, background: Bool = false, target: String = "ax",
                     waitForPresentation: Bool = true, button: String? = nil, clickCount: Int = 1) {
        guard let action = CursorFeedbackEvent.semantic(verb) else { return }
        guard enabled else {
            if ProcessInfo.processInfo.environment["GENESIS_CONTROL_CURSOR_WAIT"] == "required" {
                errorExit("Required cursor feedback conflicts with disabled feedback; input was stopped.")
            }
            return
        }
        if point == nil && target == "ax" && ProcessInfo.processInfo.environment["GENESIS_CONTROL_CURSOR_WAIT"] == "required" {
            errorExit("Required cursor feedback needs observed target geometry; input was stopped.")
        }
        var event = CursorFeedbackEvent(action: action, point: point, background: background, target: target)
        event.button = button == "left" ? nil : button
        event.clickCount = clickCount > 1 ? clickCount : nil
        event.label = CursorFeedbackText.label(
            verb: CursorFeedbackText.verb(verb, button: button, clickCount: clickCount),
            target: CursorFeedbackText.target(app: targetApp, role: targetRole, name: targetName))
        // The TypeScript wrapper puts the caller's --note and the driving agent session here.
        let environment = ProcessInfo.processInfo.environment
        event.note = CursorFeedbackText.fromEnvironment(environment["GENESIS_CONTROL_CURSOR_NOTE"],
                                                        limit: CursorFeedbackText.noteLimit)
        event.session = CursorFeedbackText.fromEnvironment(environment["GENESIS_CONTROL_CURSOR_SESSION"],
                                                           limit: CursorFeedbackText.sessionLimit)
        event.detail = detail
        if let point {
            var id: CGDirectDisplayID = 0
            var count: UInt32 = 0
            if CGGetDisplaysWithPoint(point,1,&id,&count) == .success, count == 1 {
                let bounds = CGDisplayBounds(id)
                event.displayID = id
                event.displayX = Double(point.x-bounds.minX)
                event.displayY = Double(point.y-bounds.minY)
            }
        }
        let ready = send(event, waitForPresentation: waitForPresentation)
        if !ready && ProcessInfo.processInfo.environment["GENESIS_CONTROL_CURSOR_WAIT"] == "required" {
            errorExit("Cursor presentation was not acknowledged; input was stopped. Inspect current state before retrying.")
        }
    }
    static func element(_ verb: String, _ element: AXUIElement, background: Bool = false, button: String? = nil) {
        describe(element)
        guard let p = axPointValue(element, "AXPosition"), let size = axSizeValue(element, "AXSize"),
              size.width > 0, size.height > 0 else {
            emit(verb, point: nil, background: background, button: button)
            return
        }
        emit(verb, point: CGPoint(x: p.x+size.width/2, y: p.y+size.height/2), background: background, button: button)
    }
    static func hide() {
        guard let data = try? JSONEncoder().encode(CursorFeedbackEvent(action: "hide", point: nil)) else { return }
        _ = CursorChannel.send(data)
        _ = CursorChannel.send(data, filename: CursorChannel.directory + "/events.sock")
    }
    private static func send(_ input: CursorFeedbackEvent, waitForPresentation: Bool) -> Bool {
        guard input.valid, CursorChannel.prepare() else { return false }
        do {
            var event = input
            let receipt = waitForPresentation ? try CursorReceipt() : nil
            event.receiptID = receipt?.id
            let data = try JSONEncoder().encode(event)
            if CursorChannel.send(data) {
                let ready = receipt?.wait(timeoutMs: 1500) ?? true
                if !ready { fputs("Cursor presentation receipt timed out.\n", stderr) }
                return ready
            }
            guard event.point != nil else { return false }
            let helper = Process()
            helper.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
            helper.arguments = ["cursor-feedback", "--server", "--initial", data.base64EncodedString()]
            helper.standardInput = FileHandle.nullDevice
            helper.standardOutput = FileHandle.nullDevice
            let logFD = open(CursorChannel.directory+"/errors.log", O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW, 0o600)
            let log = logFD >= 0 ? FileHandle(fileDescriptor: logFD, closeOnDealloc: true) : FileHandle.nullDevice
            helper.standardError = log
            try helper.run()
            let ready = receipt?.wait(timeoutMs: 1500) ?? true
            if !ready { fputs("Cursor startup receipt timed out.\n", stderr) }
            return ready
        } catch {
            fputs("Cursor feedback unavailable: \(error.localizedDescription)\n", stderr)
            return false
        }
    }
}

private final class CursorPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
private final class CursorView: NSView {
    override var isFlipped: Bool { true }
}

final class CursorOverlayHost {
    private var socketFD: Int32 = -1
    private var lockFD: Int32 = -1
    private var source: DispatchSourceRead?
    private var idleWork: DispatchWorkItem?
    private var semanticWork: DispatchWorkItem?
    private var fadeWork: DispatchWorkItem?
    private let artwork: CuaCursorArtwork
    private var panel: CursorPanel
    private var activeDisplayID: UInt32
    private let root = CALayer()
    private let moving = CALayer()
    private let floating = CALayer()
    private let graphic = CALayer()
    private let badge = CALayer()
    /// The click mark at the hotspot: rings, plus a menu glyph for a right-click. It does not float.
    private let marker = CALayer()
    private var markerWork: DispatchWorkItem?
    private var lastMarker: (kind: CursorClickKind, point: CGPoint?, time: CFTimeInterval)?
    private var badgeKey = ""
    /// The app that was in front before this helper drew anything, kept current as the user switches.
    private var previousFront: NSRunningApplication?
    private var activationObserver: NSObjectProtocol?
    private var currentPoint: CGPoint?
    private var action = ""
    private var lastEventTime = Date.timeIntervalSinceReferenceDate
    private var desktop: CGRect
    private var primaryTop: CGFloat
    private var screenObserver: NSObjectProtocol?
    private var displayLink: CVDisplayLink?
    private var pendingReceipts: [(id: String, deadline: Double, frames: Int)] = []
    private let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ||
        ProcessInfo.processInfo.environment["GENESIS_CONTROL_CURSOR_MOTION"] == "off"

    init(initial: CursorFeedbackEvent) throws {
        artwork = try CuaCursorArtwork()
        guard let screen = Self.screen(for:initial) ?? NSScreen.screens.first else { throw CocoaError(.featureUnsupported) }
        desktop = screen.frame
        activeDisplayID = Self.displayID(screen)
        primaryTop = Self.primaryTop(NSScreen.screens)
        panel = Self.makePanel(screen)
        let view = CursorView(frame: CGRect(origin: .zero, size: desktop.size))
        view.setAccessibilityElement(false)
        view.wantsLayer = true
        view.layer = root
        root.isGeometryFlipped = true
        root.bounds = view.bounds
        panel.contentView = view
        root.addSublayer(moving)
        moving.addSublayer(marker)
        moving.addSublayer(floating)
        floating.addSublayer(graphic)
        floating.addSublayer(badge)
        graphic.anchorPoint = .zero
        graphic.setAffineTransform(CGAffineTransform(scaleX: 42.0/128, y: 42.0/128))
        graphic.position = CGPoint(x: -55*42.0/128, y: -30*42.0/128)
        if !reduced {
            let float = CAKeyframeAnimation(keyPath: "transform")
            float.values = (0...120).map { index -> NSValue in
                let angle = Double(index)/120 * .pi*2
                var t = CATransform3DMakeTranslation(sin(angle)*5, 6*cos(angle)-5, 0)
                t = CATransform3DRotate(t, 2.5*cos(angle)*Double.pi/180, 0, 0, 1)
                return NSValue(caTransform3D: t)
            }
            float.duration = 4
            float.repeatCount = .infinity
            floating.add(float, forKey: "levitate")
        }
    }

    private static func primaryTop(_ screens: [NSScreen]) -> CGFloat {
        let primary = screens.first {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == CGMainDisplayID()
        } ?? screens.first
        return primary?.frame.maxY ?? 0
    }

    private static func makePanel(_ screen: NSScreen) -> CursorPanel {
        let panel = CursorPanel(contentRect:CGRect(origin:.zero,size:screen.frame.size),
            styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false,screen:screen)
        panel.animationBehavior = .none
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary,.ignoresCycle,.stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.setAccessibilityElement(false)
        return panel
    }

    private static func displayID(_ screen: NSScreen) -> UInt32 {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }

    private static func screen(for event: CursorFeedbackEvent) -> NSScreen? {
        if let id = event.displayID {
            return NSScreen.screens.first { displayID($0) == id }
        }
        guard let point = event.point else { return nil }
        let cocoa = CursorMotion.appKitPoint(point,primaryTop:primaryTop(NSScreen.screens))
        return NSScreen.screens.first { $0.frame.contains(cocoa) }
    }

    private func refreshDesktop(_ event: CursorFeedbackEvent) -> CGPoint? {
        guard let screen = Self.screen(for:event) ?? NSScreen.screens.first(where:{Self.displayID($0) == activeDisplayID}) else {
            panel.orderOut(nil)
            return nil
        }
        let top = Self.primaryTop(NSScreen.screens)
        let point = event.displayPoint ?? event.point.map { CursorMotion.viewPoint($0,desktop:screen.frame,primaryTop:top) } ?? currentPoint
        guard let point, CGRect(origin:.zero,size:screen.frame.size).contains(point) else {
            panel.orderOut(nil)
            return nil
        }
        if desktop != screen.frame || activeDisplayID != Self.displayID(screen) || primaryTop != top {
            let view = panel.contentView
            panel.contentView = nil
            panel.orderOut(nil)
            panel.close()
            panel = Self.makePanel(screen)
            panel.contentView = view
            view?.frame = CGRect(origin:.zero,size:screen.frame.size)
            root.bounds = CGRect(origin:.zero,size:screen.frame.size)
            moving.removeAnimation(forKey:"glide")
            currentPoint = nil
            desktop = screen.frame
            primaryTop = top
            activeDisplayID = Self.displayID(screen)
        }
        return point
    }

    private func showArtwork(_ name: String) {
        guard action != name else { return }
        action = name
        graphic.sublayers?.forEach { $0.removeFromSuperlayer() }
        graphic.addSublayer(artwork.layer(action: name, reduced: reduced))
    }
    /// The label beside the cursor: what and where, the caller's note, and who drives it.
    ///
    /// One plain dark plate with a text hierarchy (size and weight, not boxes), so it stays legible
    /// on any wallpaper and with Reduce Transparency. Increase Contrast makes it opaque with a light
    /// border. It is rebuilt only when its text changes; a drag's samples only extend its life.
    private func showBadge(_ event: CursorFeedbackEvent) {
        let kind = CursorClickKind(button: event.button, clickCount: event.clickCount)
        let key = [event.label, event.detail, event.note, event.session, event.button,
                   event.background ? "bg" : "fg", event.target]
            .map { $0 ?? "" }.joined(separator: "\u{1f}")
        scheduleBadgeFade(hasNote: event.note != nil || event.detail != nil)
        guard key != badgeKey || badge.opacity == 0 else {
            // Same text, but the cursor may now be near the other screen edge, so the side is chosen again.
            badge.frame.origin = badgeOrigin(width: badge.frame.width, height: badge.frame.height)
            return
        }
        badgeKey = key
        badge.sublayers?.forEach { $0.removeFromSuperlayer() }
        badge.removeAllAnimations()
        badge.opacity = 1
        let rgb = event.action == "click" ? kind.accent : CursorClickKind.primary.accent
        let accent = NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
        let contrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
        func font(_ size: CGFloat, mono: Bool = false) -> NSFont {
            mono ? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
                : NSFont(name: "Inter", size: size) ?? NSFont.systemFont(ofSize: size)
        }
        let place = event.target == "pixel" ? "pixel" : event.target == "ax" ? "AX" : "desktop"
        let context = [event.session, event.background ? "background" : "foreground", place]
            .compactMap { $0 }.joined(separator: " · ")
        var lines: [(text: String, size: CGFloat, color: NSColor, mono: Bool)] = [
            (event.label ?? "GenesisTools", 12, .white, false),
        ]
        // The written text sits right under what was written to, in a typewriter face, so a person
        // reads it as data rather than as part of the sentence.
        if let detail = event.detail {
            lines.append((detail, 11, contrast ? .white : NSColor(srgbRed: 0.80, green: 0.93, blue: 1, alpha: 1), true))
        }
        if let note = event.note {
            lines.append((note, 11, NSColor.white.withAlphaComponent(contrast ? 1 : 0.86), false))
        }
        lines.append((context, 10, contrast ? .white : (accent.blended(withFraction: 0.3, of: .white) ?? accent), false))
        let widest = lines.map {
            ($0.text as NSString).size(withAttributes: [.font: font($0.size, mono: $0.mono)]).width
        }.max() ?? 0
        let width = min(event.detail == nil ? 400 : 480, ceil(widest) + 32)
        let heights = lines.map { ceil($0.size * 1.34) }
        let height = heights.reduce(0, +) + 12
        badge.frame = CGRect(origin: badgeOrigin(width: width, height: height), size: CGSize(width: width, height: height))
        let background = CAGradientLayer()
        background.frame = badge.bounds
        background.cornerRadius = 9
        background.borderWidth = contrast ? 1.5 : 1
        background.borderColor = (contrast ? NSColor.white : accent.withAlphaComponent(0.5)).cgColor
        background.colors = contrast
            ? [NSColor.black.cgColor, NSColor.black.cgColor]
            : [NSColor(srgbRed: 0.08, green: 0.13, blue: 0.17, alpha: 0.97).cgColor,
               NSColor(srgbRed: 0.05, green: 0.07, blue: 0.10, alpha: 0.97).cgColor]
        background.startPoint = .zero
        background.endPoint = CGPoint(x: 1, y: 1)
        badge.addSublayer(background)
        let dot = CAShapeLayer()
        let dotY = 6 + (heights[0] - 8) / 2
        dot.path = kind == .secondary && event.action == "click"
            ? CGPath(roundedRect: CGRect(x: 9, y: dotY, width: 8, height: 8), cornerWidth: 2, cornerHeight: 2, transform: nil)
            : CGPath(ellipseIn: CGRect(x: 9, y: dotY, width: 8, height: 8), transform: nil)
        dot.fillColor = accent.cgColor
        badge.addSublayer(dot)
        var y: CGFloat = 6
        for (index, line) in lines.enumerated() {
            let label = CATextLayer()
            label.frame = CGRect(x: 23, y: y, width: width - 31, height: heights[index])
            label.string = line.text
            label.font = font(line.size, mono: line.mono)
            label.fontSize = line.size
            label.foregroundColor = line.color.cgColor
            label.isWrapped = false
            label.truncationMode = .end
            label.contentsScale = panel.backingScaleFactor
            badge.addSublayer(label)
            y += heights[index]
        }
    }

    /// Below and right of the hotspot, flipped to the other side when that would leave the screen.
    private func badgeOrigin(width: CGFloat, height: CGFloat) -> CGPoint {
        let point = currentPoint ?? .zero
        let room = root.bounds.size
        let x: CGFloat = point.x + 25 + width > room.width - 4 ? -25 - width : 25
        let y: CGFloat = point.y + 25 + height > room.height - 4 ? -25 - height : 25
        return CGPoint(x: x, y: y)
    }

    private func scheduleBadgeFade(hasNote: Bool) {
        fadeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 1
            fade.toValue = 0
            fade.duration = self.reduced ? 0 : 0.4
            fade.timingFunction = CAMediaTimingFunction(controlPoints: 1/3, 0, 2/3, 1)
            self.badge.opacity = 0
            self.badge.add(fade, forKey: "fade")
        }
        fadeWork = work
        // A note is a sentence to read, so it stays a little longer than a verb and a target.
        DispatchQueue.main.asyncAfter(deadline: .now() + (hasNote ? 3.5 : 2.4), execute: work)
    }

    /// Marks the click at the hotspot once the glide arrives: one ring for a click, two for a double
    /// click, and an amber ring with a menu glyph for a right-click. Every animation is one-shot and
    /// the layers are removed afterwards, so an idle overlay draws nothing new.
    private func showMarker(_ event: CursorFeedbackEvent, after delay: Double) {
        guard event.action == "click", event.point != nil else { return }
        let kind = CursorClickKind(button: event.button, clickCount: event.clickCount)
        let now = CACurrentMediaTime()
        // The second event of a double click lands on the same spot a moment later: one mark is enough.
        if let last = lastMarker, last.kind == kind, last.point == currentPoint, now - last.time < 0.4 {
            return
        }

        lastMarker = (kind, currentPoint, now)
        markerWork?.cancel()
        marker.sublayers?.forEach { $0.removeFromSuperlayer() }
        let rgb = kind.accent
        let accent = NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
        let begin = marker.convertTime(now, from: nil) + delay
        for index in 0..<kind.rings {
            let ring = CAShapeLayer()
            ring.path = CGPath(ellipseIn: CGRect(x: -10, y: -10, width: 20, height: 20), transform: nil)
            ring.fillColor = kind == .secondary ? accent.withAlphaComponent(0.22).cgColor : nil
            ring.strokeColor = accent.cgColor
            ring.lineWidth = 2
            marker.addSublayer(ring)
            if reduced {
                ring.opacity = 0.9
                continue
            }

            ring.opacity = 0
            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = 0.5
            grow.toValue = 1.8
            let fade = CAKeyframeAnimation(keyPath: "opacity")
            fade.values = [0, 1, 0]
            fade.keyTimes = [0, 0.2, 1]
            let pulse = CAAnimationGroup()
            pulse.animations = [grow, fade]
            pulse.duration = 0.55
            pulse.beginTime = begin + Double(index) * 0.16
            pulse.timingFunction = CAMediaTimingFunction(name: .easeOut)
            pulse.fillMode = .backwards
            ring.add(pulse, forKey: "pulse")
        }
        if kind.showsMenuGlyph {
            let glyph = menuGlyph(accent)
            // Left of the hotspot: the arrow and the label sit below and right of it.
            glyph.position = CGPoint(x: -24, y: 2)
            marker.addSublayer(glyph)
            if !reduced {
                glyph.opacity = 0
                let show = CAKeyframeAnimation(keyPath: "opacity")
                show.values = [0, 1, 1, 0]
                show.keyTimes = [0, 0.12, 0.75, 1]
                show.duration = 1.3
                show.beginTime = begin
                show.fillMode = .backwards
                glyph.add(show, forKey: "show")
            }
        }
        let work = DispatchWorkItem { [weak self] in
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            self?.marker.sublayers?.forEach { $0.removeFromSuperlayer() }
            CATransaction.commit()
        }
        markerWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay + (reduced ? 1.2 : 1.4), execute: work)
    }

    /// A small menu symbol: a rounded plate with three lines.
    private func menuGlyph(_ accent: NSColor) -> CALayer {
        let glyph = CAShapeLayer()
        glyph.path = CGPath(roundedRect: CGRect(x: -8, y: -7, width: 16, height: 14), cornerWidth: 3.5, cornerHeight: 3.5,
                            transform: nil)
        glyph.fillColor = accent.cgColor
        glyph.strokeColor = NSColor.black.withAlphaComponent(0.35).cgColor
        glyph.lineWidth = 0.5
        let lines = CAShapeLayer()
        let path = CGMutablePath()
        for y in [-3.0, 0.0, 3.0] {
            path.move(to: CGPoint(x: -4.5, y: y))
            path.addLine(to: CGPoint(x: 4.5, y: y))
        }
        lines.path = path
        lines.strokeColor = NSColor(white: 0.08, alpha: 0.9).cgColor
        lines.lineWidth = 1.4
        lines.lineCap = .round
        glyph.addSublayer(lines)
        return glyph
    }

    /// 🛑 The overlay must never be the app in front. A panel that cannot become key still left this
    /// helper frontmost (measured 2026-09-21). The .prohibited policy now stops that at the source;
    /// this hand-back stays as the second line, should macOS ever activate the helper anyway.
    private func handBackFront() {
        guard let previous = previousFront, !previous.isTerminated else {
            NSApp.deactivate()
            return
        }

        if #available(macOS 14.0, *) {
            NSApp.yieldActivation(to: previous)
            previous.activate()
        } else {
            previous.activate(options: [.activateIgnoringOtherApps])
        }
        fputs("Cursor overlay became frontmost; handed the front back to "
            + "\(previous.localizedName ?? "pid \(previous.processIdentifier)").\n", stderr)
    }

    private func receive(_ event: CursorFeedbackEvent) {
        guard event.valid else { return }
        if event.action == "hide" { finish() }
        guard let targetPoint = refreshDesktop(event) else { return }
        pendingReceipts.removeAll()
        if let link = displayLink {
            CVDisplayLinkStop(link)
            displayLink = nil
        }
        lastEventTime = Date.timeIntervalSinceReferenceDate
        let sameAction = action == event.action
        if event.action == "click" || event.action == "key" { action = "" }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        var glideDuration = 0.0
        if event.point != nil {
            let next = targetPoint
            let previous = (moving.presentation()?.position) ?? currentPoint ?? next
            moving.position = next
            moving.removeAnimation(forKey: "glide")
            if !reduced, currentPoint != nil {
                let glide = CAKeyframeAnimation(keyPath: "position")
                let points = event.action == "drag" && sameAction ? [previous,next] : CursorMotion.points(from: previous, to: next)
                glide.values = points.map { NSValue(point: $0) }
                glide.duration = event.action == "drag" && sameAction ? 0.025 : CursorMotion.duration(from: previous, to: next)
                glideDuration = glide.duration
                moving.add(glide, forKey: "glide")
            }
            currentPoint = next
        }
        guard currentPoint != nil else { CATransaction.commit(); return }
        root.opacity = 1
        root.removeAnimation(forKey: "hide")
        showArtwork(event.action)
        showBadge(event)
        showMarker(event, after: glideDuration)
        CATransaction.commit()
        panel.orderFrontRegardless()
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() {
            handBackFront()
        }
        panel.displayIfNeeded()
        CATransaction.flush()
        if let id = event.receiptID {
            pendingReceipts.append((id, ProcessInfo.processInfo.systemUptime + glideDuration, 0))
            startPresentationClock()
        }
        semanticWork?.cancel()
        let settle = DispatchWorkItem { [weak self] in
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            self?.showArtwork("idle")
            CATransaction.commit()
        }
        semanticWork = settle
        DispatchQueue.main.asyncAfter(deadline: .now()+0.8, execute: settle)
        idleWork?.cancel()
        let idle = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 1
            fade.toValue = 0
            fade.duration = self.reduced ? 0 : 0.4
            self.root.opacity = 0
            self.root.add(fade, forKey: "hide")
            DispatchQueue.main.asyncAfter(deadline: .now()+0.4) {
                if Date.timeIntervalSinceReferenceDate-self.lastEventTime >= 20 { self.finish() }
            }
        }
        idleWork = idle
        DispatchQueue.main.asyncAfter(deadline: .now()+20, execute: idle)
    }

    private func startPresentationClock() {
        if displayLink != nil { return }
        var link: CVDisplayLink?
        guard CVDisplayLinkCreateWithCGDisplay(CGDirectDisplayID(activeDisplayID), &link) == kCVReturnSuccess,
              let link else { return }
        CVDisplayLinkSetOutputCallback(link, { _, _, _, _, _, context in
            guard let context else { return kCVReturnSuccess }
            let host = Unmanaged<CursorOverlayHost>.fromOpaque(context).takeUnretainedValue()
            let observedAt = ProcessInfo.processInfo.systemUptime
            DispatchQueue.main.async { host.presentationFrame(observedAt: observedAt) }
            return kCVReturnSuccess
        }, Unmanaged.passUnretained(self).toOpaque())
        displayLink = link
        if CVDisplayLinkStart(link) != kCVReturnSuccess {
            displayLink = nil
        }
    }

    private func presentationFrame(observedAt: Double) {
        let now = ProcessInfo.processInfo.systemUptime
        pendingReceipts = pendingReceipts.compactMap { pending in
            if now > pending.deadline + 1.5 { return nil }
            guard observedAt >= pending.deadline else { return pending }
            let frames = pending.frames + 1
            if frames >= 2 && panel.isVisible {
                CursorReceipt.acknowledge(pending.id)
                return nil
            }
            return (pending.id, pending.deadline, frames)
        }
        if pendingReceipts.isEmpty, let link = displayLink {
            CVDisplayLinkStop(link)
            displayLink = nil
        }
    }

    private func finish() -> Never {
        if let link = displayLink { CVDisplayLinkStop(link) }
        source?.cancel()
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        if socketFD >= 0 { close(socketFD) }
        unlink(CursorChannel.socketPath)
        if lockFD >= 0 { close(lockFD) }
        panel.orderOut(nil)
        exit(0)
    }
    func run(initial: CursorFeedbackEvent, previousFront: NSRunningApplication?) {
        self.previousFront = previousFront
        guard CursorChannel.prepare() else { return }
        lockFD = open(CursorChannel.directory+"/owner.lock", O_CREAT|O_RDWR|O_NOFOLLOW, 0o600)
        guard lockFD >= 0 else { return }
        guard flock(lockFD, LOCK_EX|LOCK_NB) == 0 else {
            if let data = try? JSONEncoder().encode(initial) { _ = CursorChannel.send(data) }
            close(lockFD)
            return
        }
        unlink(CursorChannel.socketPath)
        socketFD = socket(AF_UNIX, SOCK_DGRAM, 0)
        guard socketFD >= 0 else { finish() }
        _ = fcntl(socketFD, F_SETFL, O_NONBLOCK)
        var address = CursorChannel.address()
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else { finish() }
        chmod(CursorChannel.socketPath, 0o600)
        let read = DispatchSource.makeReadSource(fileDescriptor: socketFD, queue: .main)
        read.setEventHandler { [weak self] in
            guard let self else { return }
            var bytes = [UInt8](repeating: 0, count: 4096)
            for _ in 0..<512 {
                let count = recv(self.socketFD, &bytes, bytes.count, MSG_DONTWAIT)
                if count < 0 { break }
                do {
                    let event = try JSONDecoder().decode(CursorFeedbackEvent.self, from: Data(bytes.prefix(count)))
                    self.receive(event)
                } catch {
                    fputs("Ignored invalid cursor feedback: \(error.localizedDescription)\n", stderr)
                }
            }
        }
        source = read
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.panel.orderOut(nil); self?.currentPoint = nil }
        // Event-driven, no polling: remember whichever app the user brings forward, and if this helper
        // is ever the one activated, give the front back at once.
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else {
                return
            }

            if app.processIdentifier == getpid() {
                self.handBackFront()
            } else {
                self.previousFront = app
            }
        }
        read.resume()
        receive(initial)
        DispatchQueue.main.asyncAfter(deadline: .now()+600) { self.finish() }
        NSApp.run()
    }
}

func runCursorFeedbackCommand() {
    if args.contains("--hide") {
        ActionCursor.hide()
        jsonOutput(["ok":true, "action":"cursor-hide"])
        return
    }
    // Draws the overlay for one act that a caller performed itself, such as a browser click
    // dispatched over the Chrome DevTools Protocol. The hardware pointer never moves; this is
    // feedback for a watching human and proves nothing about the act.
    if args.contains("--emit") {
        guard let verb = argValue("--action") else { errorExit("cursor-feedback --emit requires --action") }
        var point: CGPoint?
        if let at = argValue("--at") {
            let parts = at.split(separator: ",")
            guard parts.count == 2, let x = Double(parts[0].trimmingCharacters(in: .whitespaces)),
                  let y = Double(parts[1].trimmingCharacters(in: .whitespaces)),
                  x.isFinite, y.isFinite, abs(x) < 100000, abs(y) < 100000 else {
                errorExit("cursor-feedback --at must be finite global screen points x,y")
            }
            point = CGPoint(x: x, y: y)
        }
        guard let action = CursorFeedbackEvent.semantic(verb) else {
            errorExit("cursor-feedback --emit does not know the verb \(verb)")
        }
        let target = argValue("--target") ?? "ax"
        guard ["ax", "pixel", "desktop"].contains(target) else {
            errorExit("cursor-feedback --target must be ax, pixel or desktop")
        }
        let button = argValue("--button")
        guard button == nil || ["left", "right", "middle"].contains(button!) else {
            errorExit("cursor-feedback --button must be left, right or middle")
        }
        ActionCursor.emit(verb, point: point, background: args.contains("--background"), target: target,
                          button: button, clickCount: args.contains("--double") ? 2 : 1)
        jsonOutput(["ok": true, "action": action, "overlay": true, "inputDispatched": false])
        return
    }
    if args.contains("--preview") {
        guard let raw = argValue("--coords") else { errorExit("cursor preview requires --coords x,y") }
        let values = raw.split(separator: ",", omittingEmptySubsequences: false).compactMap { Double($0) }
        guard values.count == 2, values.allSatisfy({ $0.isFinite && abs($0) < 100000 }) else {
            errorExit("cursor preview requires finite global screen points x,y")
        }
        let point = CGPoint(x: values[0], y: values[1])
        let top = NSScreen.screens.first(where: {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == CGMainDisplayID()
        })?.frame.maxY ?? 0
        guard NSScreen.screens.contains(where: { $0.frame.contains(CursorMotion.appKitPoint(point, primaryTop: top)) }) else {
            errorExit("cursor preview point is outside the connected displays")
        }
        ActionCursor.emit("move", point: point, target: "desktop")
        jsonOutput(["ok":true,"action":"cursor-preview","x":point.x,"y":point.y,"inputDispatched":false])
        return
    }
    guard args.contains("--server"), let raw = argValue("--initial"),
          let data = Data(base64Encoded: raw), data.count <= 4096 else {
        errorExit("cursor-feedback requires --hide, --emit, --preview, or an internal server payload")
    }
    do {
        let event = try JSONDecoder().decode(CursorFeedbackEvent.self, from: data)
        guard event.valid else { errorExit("invalid cursor feedback") }
        // Read before this process becomes an app at all, so the hand-back knows where the front was.
        let previousFront = NSWorkspace.shared.frontmostApplication
        _ = NSApplication.shared
        // 🛑 .prohibited, not .accessory: an accessory app can still be made active, and this one
        // was, twice per cold start (measured 2026-10-13, an NSWorkspace activation log: cmux ->
        // ax-tool -> cmux -> ax-tool -> cmux within 100 ms of one background set). Keys typed in
        // those gaps went to the helper. A prohibited app is never activated, and its borderless
        // panel still draws above every app.
        NSApp.setActivationPolicy(.prohibited)
        NSApp.finishLaunching()
        let host = try CursorOverlayHost(initial:event)
        host.run(initial: event, previousFront: previousFront.flatMap { $0.processIdentifier == getpid() ? nil : $0 })
    } catch {
        fputs("Cursor overlay could not start: \(error.localizedDescription)\n", stderr)
    }
}
