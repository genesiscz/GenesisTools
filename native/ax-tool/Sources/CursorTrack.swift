import AppKit
import CoreGraphics
import CryptoKit
import Foundation

/// `capture --cursor-track <file>`: the pointer while the movie records, one JSON line per sample,
/// `{"t": <ms since the capture started>, "x": 0...1, "y": 0...1}` from the top left of the recorded rectangle, and
/// `"click": "left" | "right"` on the sample where a button went down. An editor zooms on the clicks and follows the
/// smoothed path (GenesisTools' recorder part, CursorTrack.swift). Sampled at 60 Hz on its own queue from the
/// window server's pointer (`CGEvent(source: nil)`) and button state, which needs no Input Monitoring grant; a
/// sample is written only when something changed, plus one every 0.5 s so a still pointer keeps its place.
///
/// With `--cursor-shapes <dir>` (the movie then records without the system cursor, `--hide-cursor`) the writer also
/// keeps the cursor's image: every 100 ms it reads `NSCursor.currentSystem` (0.64 ms a read) and hashes the image; a
/// new image is written once as `<dir>/<hash>.png` (twice the point size) and `<dir>/<hash>.json` (`hotX`, `hotY`,
/// `width`, `height` in points), and the next row carries `"shape": "<hash>"`. The first row also carries `"pw"`, the
/// recorded rectangle's width in points, so a reader knows how many movie pixels one cursor point is. Shape rows exist
/// only for a movie without the system cursor in it, which is how the editor knows to draw one.
///
/// With `--shortcuts` a row also carries `"key": "⌘⇧4"` when a shortcut was pressed, for the editor's keys overlay.
/// Only presses with ⌘ or ⌃ are kept: plain typing and ⌥ alone (which types characters such as @ on many layouts)
/// never reach the file, and macOS sends no key to a global monitor while a password field has secure input on.
final class CursorTrackWriter {
    private let handle: FileHandle
    private let rect: () -> CGRect
    private let queue = DispatchQueue(label: "ax-tool.cursor-track", qos: .userInitiated)
    private var timer: DispatchSourceTimer?
    private var started = Date()
    private var last: (x: Double, y: Double, ms: Double)?
    private var leftDown = false
    private var rightDown = false
    private var buffer = Data()
    private(set) var samples = 0
    private(set) var clicks = 0
    let path: String
    private let shapesDir: String?
    private var shapeTick = 0
    private var currentShape: String?
    private var pendingShape: String?
    private var savedShapes = Set<String>()
    private var wrotePointWidth = false
    private var pendingKeys: [String] = []
    private var paused = false

    func setPaused(_ value: Bool) {
        queue.sync {
            paused = value
            pendingKeys.removeAll()
            pendingShape = nil
            if value { flush() }
        }
    }
    private var keyMonitor: Any?
    private(set) var shortcuts = 0
    var shapeCount: Int { queue.sync { savedShapes.count } }

    /// `rect` is the recorded rectangle in global display points (top-left origin), read per sample, so a window
    /// that moves keeps its cursor coordinates right.
    init?(path: String, shapes: String? = nil, rect: @escaping () -> CGRect) {
        let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { return nil }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        self.path = path
        self.handle = handle
        self.rect = rect
        if let shapes, (try? FileManager.default.createDirectory(atPath: shapes, withIntermediateDirectories: true)) != nil {
            shapesDir = shapes
        } else {
            shapesDir = nil
        }
    }

    /// Keeps the shortcuts pressed while it records (call on the main thread, whose run loop delivers them).
    func watchShortcuts() {
        keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard !event.isARepeat, let label = Self.shortcutLabel(event) else { return }
            self?.queue.async {
                guard let self, !self.paused else { return }
                self.pendingKeys.append(label)
            }
        }
    }

    /// "⌃⌥⇧⌘K" in Apple's order, or nil for a press without ⌘ or ⌃.
    static func shortcutLabel(_ event: NSEvent) -> String? {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.contains(.command) || flags.contains(.control) else { return nil }
        var label = ""
        if flags.contains(.control) { label += "⌃" }
        if flags.contains(.option) { label += "⌥" }
        if flags.contains(.shift) { label += "⇧" }
        if flags.contains(.command) { label += "⌘" }
        let named: [UInt16: String] = [36: "↩", 48: "⇥", 49: "Space", 51: "⌫", 53: "⎋", 117: "⌦", 123: "←", 124: "→",
                                       125: "↓", 126: "↑", 115: "↖", 119: "↘", 116: "⇞", 121: "⇟", 122: "F1", 120: "F2",
                                       99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10",
                                       103: "F11", 111: "F12", 105: "F13", 107: "F14", 113: "F15"]
        if let name = named[event.keyCode] {
            label += name
        } else if let characters = event.charactersIgnoringModifiers, !characters.isEmpty {
            label += characters.uppercased()
        } else {
            return nil
        }
        return label
    }

    func start(at started: Date) {
        self.started = started
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .nanoseconds(16_666_667), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in self?.sample() }
        timer.resume()
        self.timer = timer
    }

    func stop() {
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        queue.sync {
            timer?.cancel()
            timer = nil
            flush()
        }
        try? handle.close()
    }

    private func sample() {
        guard !paused, let point = CGEvent(source: nil)?.location else { return }
        let frame = rect()
        guard frame.width > 0, frame.height > 0 else { return }
        let ms = Date().timeIntervalSince(started) * 1000
        let x = Double((point.x - frame.minX) / frame.width)
        let y = Double((point.y - frame.minY) / frame.height)
        let left = CGEventSource.buttonState(.combinedSessionState, button: .left)
        let right = CGEventSource.buttonState(.combinedSessionState, button: .right)
        var click: String?
        if left && !leftDown { click = "left" } else if right && !rightDown { click = "right" }
        leftDown = left
        rightDown = right
        if shapesDir != nil {
            if shapeTick % 6 == 0 { readShape() }
            shapeTick += 1
        }
        let moved = last.map { abs($0.x - x) > 0.0005 || abs($0.y - y) > 0.0005 } ?? true
        let stale = last.map { ms - $0.ms >= 500 } ?? true
        guard moved || stale || click != nil || pendingShape != nil || !pendingKeys.isEmpty else { return }
        last = (x, y, ms)
        var line = String(format: "{\"t\":%.1f,\"x\":%.5f,\"y\":%.5f", ms, x, y)
        if let click {
            line += ",\"click\":\"\(click)\""
            clicks += 1
        }
        if let shape = pendingShape {
            line += ",\"shape\":\"\(shape)\""
            pendingShape = nil
        }
        if let key = pendingKeys.last {
            // Two presses inside one 16 ms sample keep the last; the editor shows one shortcut at a time.
            let escaped = key.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
            line += ",\"key\":\"\(escaped)\""
            shortcuts += pendingKeys.count
            pendingKeys.removeAll()
        }
        if shapesDir != nil, !wrotePointWidth {
            line += String(format: ",\"pw\":%.1f", frame.width)
            wrotePointWidth = true
        }
        line += "}\n"
        buffer.append(Data(line.utf8))
        samples += 1
        if buffer.count > 16_384 { flush() }
    }

    /// The cursor's image now; a new one is saved once and named on the next row.
    private func readShape() {
        guard let dir = shapesDir, let cursor = NSCursor.currentSystem, let tiff = cursor.image.tiffRepresentation else { return }
        let hash = SHA256.hash(data: tiff).prefix(6).map { String(format: "%02x", $0) }.joined()
        guard hash != currentShape else { return }
        currentShape = hash
        pendingShape = hash
        guard !savedShapes.contains(hash) else { return }
        savedShapes.insert(hash)
        let size = cursor.image.size
        let base = (dir as NSString).appendingPathComponent(hash)
        guard !FileManager.default.fileExists(atPath: base + ".png"),
              let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * 2), pixelsHigh: Int(size.height * 2),
                                            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
        bitmap.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        cursor.image.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        let meta = String(format: "{\"hotX\":%.2f,\"hotY\":%.2f,\"width\":%.2f,\"height\":%.2f}\n",
                          cursor.hotSpot.x, cursor.hotSpot.y, size.width, size.height)
        try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: base + ".png"))
        try? Data(meta.utf8).write(to: URL(fileURLWithPath: base + ".json"))
    }

    private func flush() {
        guard !buffer.isEmpty else { return }
        handle.write(buffer)
        buffer.removeAll(keepingCapacity: true)
    }
}

/// A rectangle one thread writes and another reads.
final class LockedRect: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: CGRect

    init(_ rect: CGRect) {
        stored = rect
    }

    var value: CGRect {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}
