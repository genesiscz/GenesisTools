import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// Replays a recorded widget snapshot in the real `LiveWidgetView`, scrolls its list, and measures the idle main
/// thread afterwards. A panel that keeps re-laying itself out after the scroll stopped is the widget hang Martin hit
/// twice on 2026-10-23 ("totally hanged when i scrolled a bit through the inbox"). Local only: it needs a snapshot
/// from `tools hub widget snapshot --selected <key> --json`, so it skips unless these are set:
/// `GENESIS_WIDGET_REPLAY` (the snapshot file), `GENESIS_WIDGET_REPLAY_KEY` (the session key) and optionally
/// `GENESIS_WIDGET_REPLAY_OPEN` (the decision number whose card is open) and `GENESIS_WIDGET_REPLAY_OVERVIEW=1`.
@MainActor
final class WidgetScrollReplayTests: XCTestCase {
    func testScrollingTheInboxLeavesTheMainThreadIdle() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let snapshotPath = environment["GENESIS_WIDGET_REPLAY"], let key = environment["GENESIS_WIDGET_REPLAY_KEY"]
        else { throw XCTSkip("set GENESIS_WIDGET_REPLAY and GENESIS_WIDGET_REPLAY_KEY to replay a recorded snapshot") }
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("widget-replay-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        // The fake `tools` is made once and kept: macOS checks a new executable in syspolicyd after it starts, and a check
        // that finds the file gone crashed it (2026-10-14). It reads the snapshot beside it; only that copy is replaced.
        let fixtures = try XCTUnwrap(FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first)
            .appendingPathComponent("GenesisKitTests/widget-replay-v1")
        try FileManager.default.createDirectory(at: fixtures, withIntermediateDirectories: true)
        let snapshot = fixtures.appendingPathComponent("snapshot.json")
        try? FileManager.default.removeItem(at: snapshot)
        try FileManager.default.copyItem(atPath: snapshotPath, toPath: snapshot.path)
        defer { try? FileManager.default.removeItem(at: snapshot) }
        let script = fixtures.appendingPathComponent("tools")
        if !FileManager.default.isExecutableFile(atPath: script.path) {
            try """
            #!/bin/sh
            snapshot="$(dirname "$0")/snapshot.json"
            case "$*" in
              *watch*) cat "$snapshot"; printf '\\n'; cat > /dev/null; exit 0 ;;
              *snapshot*) cat "$snapshot"; exit 0 ;;
              *"voice listen"*)
                text=""; i=0
                for word in Ship the composer waves. While I talk the words appear here; do
                  i=$((i + 1)); text="$text $word"
                  printf '{"kind":"level","rms":0.0%d}\\n' $(( (i * 37) % 8 + 2 ))
                  printf '{"kind":"partial","text":"%s"}\\n' "${text# }"
                  case "$word" in *.) printf '{"kind":"final","text":"%s"}\\n' "${text# }"; text="" ;; esac
                  sleep 0.05
                done
                sleep 4; exit 0 ;;
            esac
            printf '{}'
            """.write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        }
        let domain = "widget-replay." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { UserDefaults(suiteName: domain)?.removePersistentDomain(forName: domain) }
        let model = WidgetModel(
            binaryPath: script.path, stateRoot: directory.path, defaults: defaults,
            appearance: NativeSettingsAppearance(defaults: defaults, notificationNamespace: domain, observeExternalChanges: false))
        defer { model.stop() }
        model.startSettings()
        let deadline = ContinuousClock.now + .seconds(20)
        while model.snapshot == nil && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertNotNil(model.snapshot, "the recorded snapshot loads")
        model.select(key)
        model.section = "Inbox"
        // `GENESIS_WIDGET_REPLAY_OVERVIEW=1`: the inbox of every session (the inbox button), not the one session.
        if environment["GENESIS_WIDGET_REPLAY_OVERVIEW"] == "1" { model.inboxOverview = true }
        if let number = environment["GENESIS_WIDGET_REPLAY_OPEN"].flatMap(Int.init),
           let card = model.cards.first(where: { $0.number == number }) {
            model.openCard(card)
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 914, height: 900),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = .black
        window.contentView = NSHostingView(rootView: LiveWidgetView(model: model, edge: .right, embedded: true)
            .frame(width: 914, height: 900).background(Color(white: 0.11)).environment(\.colorScheme, .dark))
        // `GENESIS_WIDGET_REPLAY_VISIBLE=1`: an almost transparent window above the others that ignores the mouse. A window
        // below the desktop is occluded, and AppKit skips the display passes of an occluded window.
        if environment["GENESIS_WIDGET_REPLAY_VISIBLE"] == "1" || environment["GENESIS_WIDGET_REPLAY_PNG"] != nil {
            window.alphaValue = 0.02
            window.ignoresMouseEvents = true
            window.level = .floating
            window.setFrameOrigin(NSPoint(x: 0, y: 0))
            window.orderFrontRegardless()
        } else {
            window.alphaValue = 0
            window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
            window.order(.below, relativeTo: 0)
        }
        defer { window.orderOut(nil); window.close() }
        try await Task.sleep(for: .seconds(2))
        print("replay: window visible to the user: \(window.occlusionState.contains(.visible))")
        // `GENESIS_WIDGET_REPLAY_PNG=<path>`: a picture of the panel (it shows the window at 0.02 alpha for the capture), with `GENESIS_WIDGET_REPLAY_VIEW` = "staged" (the
        // staged list), "leave" (the question before closing) or "voice" (a dictation streaming words) set first.
        if let png = environment["GENESIS_WIDGET_REPLAY_PNG"] {
            switch environment["GENESIS_WIDGET_REPLAY_VIEW"] {
            case "staged": model.stagedView = "session"
            case "leave": model.stagedLeavePrompt = true
            case "voice": model.startVoice(.dictate)
            default: break
            }
            try await Task.sleep(for: .seconds(1))
            // The window server's picture of the window: cacheDisplay leaves out SwiftUI's materials and layer-drawn
            // backgrounds, and the panel's white text came out on white.
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-o", "-l", String(window.windowNumber), png]
            try capture.run()
            capture.waitUntilExit()
            XCTAssertEqual(capture.terminationStatus, 0, "screencapture of the replay window")
            // The capture keeps the window's 0.02 alpha with the colours stored unassociated, so a viewer shows it
            // almost white. Dropping the alpha channel gives the panel as it looks on screen.
            let url = URL(fileURLWithPath: png)
            let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
            let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            let skip: CGImageAlphaInfo = [.first, .premultipliedFirst].contains(image.alphaInfo) ? .noneSkipFirst : .noneSkipLast
            let info = CGBitmapInfo(rawValue: image.bitmapInfo.rawValue & ~CGBitmapInfo.alphaInfoMask.rawValue | skip.rawValue)
            let opaque = try XCTUnwrap(CGImage(width: image.width, height: image.height,
                bitsPerComponent: image.bitsPerComponent, bitsPerPixel: image.bitsPerPixel, bytesPerRow: image.bytesPerRow,
                space: try XCTUnwrap(image.colorSpace), bitmapInfo: info, provider: try XCTUnwrap(image.dataProvider),
                decode: nil, shouldInterpolate: false, intent: .defaultIntent))
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, opaque, nil)
            XCTAssertTrue(CGImageDestinationFinalize(destination), "the opaque picture is written")
            print("replay: picture \(png)")
            return
        }
        let scrollView = try XCTUnwrap(Self.scrollViews(in: window.contentView!).max {
            ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0)
        }, "the inbox list is a scroll view")
        RenderProbe.enabled = true
        defer { RenderProbe.enabled = false }
        let quiet = try await measure(seconds: 2)
        var offset: CGFloat = 0
        let document = scrollView.documentView?.frame.height ?? 0
        let viewport = scrollView.contentView.bounds.height
        print("replay: document \(Int(document)) viewport \(Int(viewport)) cards \(model.cards.count)")
        print("replay: before scroll \(quiet.text)")
        var worst: Sample?
        // Down to the end in small steps, then stops at several points near the end, where a lazy list's
        // estimated height and the clamped offset can chase each other.
        // `GENESIS_WIDGET_REPLAY_STOPS=630,1140`: only these offsets, for a quick check of one spot.
        let only = environment["GENESIS_WIDGET_REPLAY_STOPS"]?.split(separator: ",").compactMap { Double($0) }.map { CGFloat($0) }
        let stops = only ?? (Array(stride(from: CGFloat(0), through: document + 200, by: 30)) + [document - viewport - 40,
            document - viewport - 5, document - viewport, document, document - viewport / 2])
        for (index, target) in stops.enumerated() {
            let limit = max(0, (scrollView.documentView?.frame.height ?? document) - viewport)
            offset = min(limit, max(0, target))
            scrollView.contentView.scroll(to: NSPoint(x: 0, y: offset))
            scrollView.reflectScrolledClipView(scrollView.contentView)
            try await Task.sleep(for: .milliseconds(40))
            // Every stop is measured: the loop needs a tall open card right at the viewport top edge.
            // `GENESIS_WIDGET_REPLAY_HOLD=<seconds>`: stay at each stop that long, to sample the process there.
            let hold = environment["GENESIS_WIDGET_REPLAY_HOLD"].flatMap(Double.init)
            // `GENESIS_WIDGET_REPLAY_SAMPLE=<folder>`: sample this process during each hold, one file per stop.
            if let folder = environment["GENESIS_WIDGET_REPLAY_SAMPLE"], let hold {
                let sampler = Process()
                sampler.executableURL = URL(fileURLWithPath: "/usr/bin/sample")
                sampler.arguments = [String(getpid()), String(max(1, Int(hold) - 1)), "1", "-mayDie", "-file",
                                     folder + "/replay-stop-\(Int(offset)).sample.txt"]
                sampler.standardOutput = FileHandle.nullDevice
                sampler.standardError = FileHandle.nullDevice
                try? sampler.run()
            }
            let sample = try await measure(seconds: hold ?? (index >= stops.count - 5 ? 1.5 : 0.5))
            if sample.loops > 60 || index >= stops.count - 5 {
                print("replay: stop at \(Int(offset)) doc \(Int(scrollView.documentView?.frame.height ?? 0)) \(sample.text)")
            }
            if sample.cpu > (worst?.cpu ?? -1) { worst = sample }
        }
        let after = try XCTUnwrap(worst)
        XCTAssertLessThan(after.loops, max(300, quiet.loops * 4), "the run loop goes quiet once the scroll stops")
        XCTAssertLessThan(after.cpu, 0.25, "the idle main thread spends under a quarter second of 1.5 s on the panel")
    }

    private struct Sample {
        let loops: Int
        let cpu: Double
        let renders: [String: Int]
        var text: String {
            "loops=\(loops) cpu=\(String(format: "%.2f", cpu))s renders="
                + renders.sorted { $0.value > $1.value }.prefix(8).map { "\($0.key)=\($0.value)" }.joined(separator: " ")
        }
    }

    /// Run-loop passes, main-thread CPU and view bodies over `seconds` of doing nothing.
    private func measure(seconds: Double) async throws -> Sample {
        var loops = 0
        let observer = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.beforeSources.rawValue,
                                                          true, 0) { _, _ in loops += 1 }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        defer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        let start = RenderProbe.snapshot()
        let cpuStart = Self.threadCPU()
        try await Task.sleep(for: .seconds(seconds))
        let now = RenderProbe.snapshot()
        let renders = now.reduce(into: [String: Int]()) { result, entry in
            let delta = entry.value - (start[entry.key] ?? 0)
            if delta > 0 { result[entry.key] = delta }
        }
        return Sample(loops: loops, cpu: Self.threadCPU() - cpuStart, renders: renders)
    }

    private static func threadCPU() -> Double {
        var time = timespec()
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, &time)
        return Double(time.tv_sec) + Double(time.tv_nsec) / 1e9
    }

    private static func scrollViews(in view: NSView) -> [NSScrollView] {
        ((view as? NSScrollView).map { [$0] } ?? []) + view.subviews.flatMap(scrollViews)
    }
}
