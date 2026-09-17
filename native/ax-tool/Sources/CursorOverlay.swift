import AppKit
import Darwin
import Foundation
import QuartzCore
import SnapshotSupport

private enum CursorChannel {
    static let directory = "/tmp/genesis-control-cursor-\(getuid())"
    static let socketPath = directory + "/events.sock"
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
    static func address() -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8) + [0]
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: bytes) }
        return address
    }
    static func send(_ data: Data) -> Bool {
        let fd = socket(AF_UNIX, SOCK_DGRAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var address = address()
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
    static var enabled: Bool {
        !CommandLine.arguments.contains("--no-cursor") &&
        ProcessInfo.processInfo.environment["GENESIS_CONTROL_CURSOR"] != "off"
    }
    static func emit(_ verb: String, point: CGPoint?, background: Bool = false, target: String = "ax") {
        guard enabled, let action = CursorFeedbackEvent.semantic(verb) else { return }
        send(CursorFeedbackEvent(action: action, point: point, background: background, target: target))
    }
    static func element(_ verb: String, _ element: AXUIElement, background: Bool = false) {
        guard let p = axPointValue(element, "AXPosition"), let size = axSizeValue(element, "AXSize"),
              size.width > 0, size.height > 0 else {
            emit(verb, point: nil, background: background)
            return
        }
        emit(verb, point: CGPoint(x: p.x+size.width/2, y: p.y+size.height/2), background: background)
    }
    static func hide() {
        guard let data = try? JSONEncoder().encode(CursorFeedbackEvent(action: "hide", point: nil)) else { return }
        _ = CursorChannel.send(data)
    }
    private static func send(_ event: CursorFeedbackEvent) {
        guard event.valid, CursorChannel.prepare() else { return }
        do {
            let data = try JSONEncoder().encode(event)
            if CursorChannel.send(data) { return }
            guard event.point != nil else { return }
            let helper = Process()
            helper.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
            helper.arguments = ["cursor-feedback", "--server", "--initial", data.base64EncodedString()]
            helper.standardInput = FileHandle.nullDevice
            helper.standardOutput = FileHandle.nullDevice
            let logFD = open(CursorChannel.directory+"/errors.log", O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW, 0o600)
            let log = logFD >= 0 ? FileHandle(fileDescriptor: logFD, closeOnDealloc: true) : FileHandle.nullDevice
            helper.standardError = log
            try helper.run()
        } catch {
            fputs("Cursor feedback unavailable: \(error.localizedDescription)\n", stderr)
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
    private let panel: CursorPanel
    private let root = CALayer()
    private let moving = CALayer()
    private let floating = CALayer()
    private let graphic = CALayer()
    private let badge = CALayer()
    private var currentPoint: CGPoint?
    private var action = ""
    private var lastEventTime = Date.timeIntervalSinceReferenceDate
    private let desktop: CGRect
    private let primaryTop: CGFloat
    private let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ||
        ProcessInfo.processInfo.environment["GENESIS_CONTROL_CURSOR_MOTION"] == "off"

    init() throws {
        artwork = try CuaCursorArtwork()
        desktop = NSScreen.screens.reduce(CGRect.null) { $0.union($1.frame) }
        primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        panel = CursorPanel(contentRect: desktop, styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.setAccessibilityElement(false)
        let view = CursorView(frame: CGRect(origin: .zero, size: desktop.size))
        view.setAccessibilityElement(false)
        view.wantsLayer = true
        view.layer = root
        root.isGeometryFlipped = true
        root.bounds = view.bounds
        panel.contentView = view
        root.addSublayer(moving)
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

    private func showArtwork(_ name: String) {
        guard action != name else { return }
        action = name
        graphic.sublayers?.forEach { $0.removeFromSuperlayer() }
        graphic.addSublayer(artwork.layer(action: name, reduced: reduced))
    }
    private func showBadge(_ event: CursorFeedbackEvent) {
        badge.sublayers?.forEach { $0.removeFromSuperlayer() }
        badge.removeAllAnimations()
        badge.opacity = 1
        let accent = NSColor(srgbRed: 94.0/255, green: 192.0/255, blue: 232.0/255, alpha: 1)
        let title = "GenesisTools"
        let font = NSFont(name: "Inter", size: 11.5) ?? NSFont.systemFont(ofSize: 11.5)
        let width = min(188, (title as NSString).size(withAttributes: [.font: font]).width + 83)
        badge.frame = CGRect(x: 25, y: 25, width: width, height: 28)
        let background = CAGradientLayer()
        background.frame = badge.bounds
        background.cornerRadius = 9
        background.borderWidth = 1
        background.borderColor = accent.withAlphaComponent(0.45).cgColor
        background.colors = [NSColor(srgbRed: 0.08, green: 0.19, blue: 0.25, alpha: 0.98).cgColor,
                             NSColor(srgbRed: 0.05, green: 0.07, blue: 0.10, alpha: 0.98).cgColor]
        background.startPoint = .zero
        background.endPoint = CGPoint(x: 1, y: 1)
        badge.addSublayer(background)
        let dot = CAShapeLayer()
        dot.path = CGPath(ellipseIn: CGRect(x: 8, y: 10, width: 8, height: 8), transform: nil)
        dot.fillColor = accent.cgColor
        badge.addSublayer(dot)
        func text(_ value: String, frame: CGRect, color: NSColor, size: CGFloat) {
            let label = CATextLayer()
            label.frame = frame
            label.string = value
            label.font = font
            label.fontSize = size
            label.foregroundColor = color.cgColor
            label.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
            badge.addSublayer(label)
        }
        text(title, frame: CGRect(x: 22, y: 6, width: width-76, height: 18), color: .white, size: 11.5)
        for (offset, value) in [event.background ? "BG" : "FG", event.target == "pixel" ? "PX" : event.target == "ax" ? "AX" : "OS"].enumerated() {
            let chip = CALayer()
            chip.frame = CGRect(x: width - 47 + CGFloat(offset)*22, y: 5, width: 18, height: 18)
            chip.cornerRadius = 4
            chip.backgroundColor = offset == 0 ? accent.cgColor : NSColor.clear.cgColor
            chip.borderColor = accent.cgColor
            chip.borderWidth = 1
            badge.addSublayer(chip)
            text(value, frame: CGRect(x: chip.frame.minX+2, y: 8, width: 16, height: 12),
                 color: offset == 0 ? .black : accent, size: 8)
        }
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
        DispatchQueue.main.asyncAfter(deadline: .now()+2, execute: work)
    }

    private func receive(_ event: CursorFeedbackEvent) {
        guard event.valid else { return }
        if event.action == "hide" { finish() }
        lastEventTime = Date.timeIntervalSinceReferenceDate
        let sameAction = action == event.action
        if event.action == "click" || event.action == "key" { action = "" }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let point = event.point {
            let next = CursorMotion.viewPoint(point, desktop: desktop, primaryTop: primaryTop)
            let previous = (moving.presentation()?.position) ?? currentPoint ?? next
            moving.position = next
            moving.removeAnimation(forKey: "glide")
            if !reduced, currentPoint != nil {
                let glide = CAKeyframeAnimation(keyPath: "position")
                let points = event.action == "drag" && sameAction ? [previous,next] : CursorMotion.points(from: previous, to: next)
                glide.values = points.map { NSValue(point: $0) }
                glide.duration = event.action == "drag" && sameAction ? 0.025 : CursorMotion.duration(from: previous, to: next)
                moving.add(glide, forKey: "glide")
            }
            currentPoint = next
        }
        guard currentPoint != nil else { CATransaction.commit(); return }
        root.opacity = 1
        root.removeAnimation(forKey: "hide")
        showArtwork(event.action)
        if !sameAction { showBadge(event) }
        CATransaction.commit()
        panel.orderFrontRegardless()
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

    private func finish() -> Never {
        source?.cancel()
        if socketFD >= 0 { close(socketFD) }
        unlink(CursorChannel.socketPath)
        if lockFD >= 0 { close(lockFD) }
        panel.orderOut(nil)
        exit(0)
    }
    func run(initial: CursorFeedbackEvent) {
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
    guard args.contains("--server"), let raw = argValue("--initial"),
          let data = Data(base64Encoded: raw), data.count <= 4096 else {
        errorExit("cursor-feedback requires --hide or an internal server payload")
    }
    do {
        let event = try JSONDecoder().decode(CursorFeedbackEvent.self, from: data)
        guard event.valid else { errorExit("invalid cursor feedback") }
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        let host = try CursorOverlayHost()
        host.run(initial: event)
    } catch {
        fputs("Cursor overlay could not start: \(error.localizedDescription)\n", stderr)
    }
}
