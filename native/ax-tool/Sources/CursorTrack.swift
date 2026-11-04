import CoreGraphics
import Foundation

/// `capture --cursor-track <file>`: the pointer while the movie records, one JSON line per sample,
/// `{"t": <ms since the capture started>, "x": 0...1, "y": 0...1}` from the top left of the recorded rectangle, and
/// `"click": "left" | "right"` on the sample where a button went down. An editor zooms on the clicks and follows the
/// smoothed path (GenesisTools' recorder part, CursorTrack.swift). Sampled at 60 Hz on its own queue from the
/// window server's pointer (`CGEvent(source: nil)`) and button state, which needs no Input Monitoring grant; a
/// sample is written only when something changed, plus one every 0.5 s so a still pointer keeps its place.
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

    /// `rect` is the recorded rectangle in global display points (top-left origin), read per sample, so a window
    /// that moves keeps its cursor coordinates right.
    init?(path: String, rect: @escaping () -> CGRect) {
        guard FileManager.default.createFile(atPath: path, contents: nil), let handle = FileHandle(forWritingAtPath: path) else {
            return nil
        }
        self.path = path
        self.handle = handle
        self.rect = rect
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
        queue.sync {
            timer?.cancel()
            timer = nil
            flush()
        }
        try? handle.close()
    }

    private func sample() {
        guard let point = CGEvent(source: nil)?.location else { return }
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
        let moved = last.map { abs($0.x - x) > 0.0005 || abs($0.y - y) > 0.0005 } ?? true
        let stale = last.map { ms - $0.ms >= 500 } ?? true
        guard moved || stale || click != nil else { return }
        last = (x, y, ms)
        var line = String(format: "{\"t\":%.1f,\"x\":%.5f,\"y\":%.5f", ms, x, y)
        if let click {
            line += ",\"click\":\"\(click)\""
            clicks += 1
        }
        line += "}\n"
        buffer.append(Data(line.utf8))
        samples += 1
        if buffer.count > 16_384 { flush() }
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
