// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Pomodoro/FocusChime.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import UserNotifications

/// Spec 22 (S6) §10.5 — the sound and the notification a phase boundary makes.
///
/// A timer you have to watch is not a timer. The chime is a named system sound so it matches
/// whatever the machine already sounds like, and the notification carries the same sentence, so
/// a phase change lands whether the HUD is on screen, behind something, or on another display.
@MainActor
enum FocusChime {
    /// Names from `/System/Library/Sounds`. Kept short and non-alarming: this fires every
    /// 25 minutes, and anything dramatic becomes hateful by the third hour.
    static let available = ["Glass", "Ping", "Submarine", "Tink", "Blow", "Pop"]
    static let defaultName = "Glass"
    /// `userInfo[kind]` of every phase notification, so a click on one can be routed to the timer.
    static let notificationKind = "focus.phase"

    static func play(_ name: String?) {
        guard let name, name != "off", !name.isEmpty else { return }
        // A test run must be silent: `swift test` drives whole pomodoro cycles in milliseconds,
        // and every boundary would ring.
        guard Bundle.main.bundleIdentifier == "dev.foltyn.genesis" else { return }
        NSSound(named: NSSound.Name(name))?.play()
    }

    /// The "no flow is running" nudge: a soft two-note chime, synthesised so it can never be
    /// mistaken for the phase ding or a system alert. Quiet on purpose: it fires while you are
    /// typing, and a loud one would feel like being told off.
    static func nudge() {
        guard Bundle.main.bundleIdentifier == "dev.foltyn.genesis" else { return }
        if nudgeSound == nil { nudgeSound = NSSound(data: nudgeWAV()) }
        nudgeSound?.stop()
        nudgeSound?.play()
    }

    private static var nudgeSound: NSSound?

    /// 16-bit mono PCM WAV: E5 then B5, soft attack, exponential decay, peak well below full
    /// scale. Internal so a test can check that it stays gentle.
    static func nudgeWAV(sampleRate: Int = 44_100) -> Data {
        let count = Int(Double(sampleRate) * 1.4)
        let notes: [(freq: Double, start: Double, gain: Double)] = [(659.25, 0, 0.16), (987.77, 0.16, 0.12)]
        var data = Data()
        func put<T: FixedWidthInteger>(_ value: T) {
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        data.append(contentsOf: Array("RIFF".utf8))
        put(UInt32(36 + count * 2))
        data.append(contentsOf: Array("WAVEfmt ".utf8))
        put(UInt32(16)); put(UInt16(1)); put(UInt16(1))
        put(UInt32(sampleRate)); put(UInt32(sampleRate * 2)); put(UInt16(2)); put(UInt16(16))
        data.append(contentsOf: Array("data".utf8))
        put(UInt32(count * 2))
        for index in 0 ..< count {
            let time = Double(index) / Double(sampleRate)
            var value = 0.0
            for note in notes where time >= note.start {
                let local = time - note.start
                let envelope = min(1, local / 0.012) * exp(-local / 0.32)
                value += note.gain * envelope * sin(2 * .pi * note.freq * local)
            }
            put(Int16(max(-1, min(1, value)) * Double(Int16.max)))
        }
        return data
    }

    /// Fire-and-forget preview for the settings picker.
    static func preview(_ name: String) { play(name) }

    /// Posts the phase-change notification. Authorisation is the app's existing one (spec 19);
    /// a refusal is silent here rather than a modal — the sound already did the job.
    static func notify(finished: PomodoroPlan.Phase, next: PomodoroPlan.Phase, autoStarted: Bool) {
        // Same guard `UNMonitorNotifier` carries: under `swift test` the bundle is not
        // Genesis.app, and `UNUserNotificationCenter.current()` does not fail there, it raises
        // and takes the test process down with it.
        guard Bundle.main.bundleIdentifier == "dev.foltyn.genesis" else { return }
        let content = UNMutableNotificationContent()
        content.title = "\(finished.label) finished"
        content.body = autoStarted
            ? "\(next.label) has started."
            : "\(next.label) is ready when you are."
        content.sound = nil // the chime already played; two sounds for one event is noise
        content.categoryIdentifier = "focus.phase"
        content.userInfo = [QaNotificationIDs.kindKey: notificationKind]

        let request = UNNotificationRequest(
            identifier: "focus.phase.\(Int(Date().timeIntervalSince1970))",
            content: content,
            trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                Log.app.debug("focus phase notification failed: \(error.localizedDescription)")
            }
        }
    }
}
