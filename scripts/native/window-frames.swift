// Samples one window's on-screen bounds from the window server every few milliseconds and prints a line per change.
// Build: swiftc -O scripts/native/window-frames.swift -o /tmp/window-frames
// Use:   /tmp/window-frames <window-id> <seconds> [interval-ms]
// What it shows is what the user sees (CGWindowList), not what the app asked for (setFrame).
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 3, let windowID = UInt32(args[1]), let seconds = Double(args[2]) else {
    FileHandle.standardError.write(Data("usage: window-frames <window-id> <seconds> [interval-ms]\n".utf8))
    exit(2)
}
let interval = args.count > 3 ? (Double(args[3]) ?? 4) / 1000 : 0.004
let start = Date()
var last = ""
while Date().timeIntervalSince(start) < seconds {
    let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]] ?? []
    if let bounds = info.first?[kCGWindowBounds as String] as? [String: CGFloat] {
        let line = "x=\(Int(bounds["X"] ?? 0)) y=\(Int(bounds["Y"] ?? 0)) w=\(Int(bounds["Width"] ?? 0)) h=\(Int(bounds["Height"] ?? 0))"
        if line != last {
            print(String(format: "%7.1fms  ", Date().timeIntervalSince(start) * 1000) + line)
            fflush(stdout)
            last = line
        }
    }
    Thread.sleep(forTimeInterval: interval)
}
