import AppKit
import SwiftUI

// MARK: - The screen beside the sound (R41, G-SCR-1, G-SCR-2, G-SCR-3)
//
// Presentational only. b-swift-timeline places `ScreenBesidePlayback` in the dock beside the zoomed timeline (per
// `meetings.screen.besidePlayback`), decodes the frames itself, and runs `ScreenFrameThrottle` on the player's
// position to pick the frame to decode.

/// A display the frames come from, as the menu lists it.
struct ScreenDisplayChoice: Equatable, Hashable, Identifiable {
    let id: Int
    let name: String
    let frames: Int
}

/// At most one frame change per `minIntervalSec`, and the old frame stays until the new one is decoded (G-SCR-3).
///
/// The wiring agent calls `offer` with the frame the position wants (on each 10 Hz tick), decodes the frame it
/// returns, and calls `decoded` when the image is ready; `shown` is the frame on screen. A frame offered too soon
/// waits as `pending` and is returned by `due(at:)` once the interval has passed.
struct ScreenFrameThrottle: Equatable {
    var minIntervalSec: Double = 1
    /// The frame on screen (its file name).
    private(set) var shown: String?
    /// The frame being decoded.
    private(set) var decoding: String?
    /// The newest frame asked for too soon.
    private(set) var pending: String?
    private(set) var lastChangeAt: Double?

    init(minIntervalSec: Double = 1) {
        self.minIntervalSec = minIntervalSec
    }

    /// The frame to start decoding now, or nil (the same frame, one already decoding, or too soon: kept as pending).
    mutating func offer(_ frame: String?, at now: Double) -> String? {
        guard let frame, frame != shown, frame != decoding else {
            if frame == shown { pending = nil }
            return nil
        }
        if let lastChangeAt, now - lastChangeAt < minIntervalSec {
            pending = frame
            return nil
        }
        pending = nil
        decoding = frame
        return frame
    }

    /// The pending frame once the interval has passed (call it on the next tick).
    mutating func due(at now: Double) -> String? {
        guard let pending else { return nil }
        return offer(pending, at: now)
    }

    /// The decoded frame goes on screen; a decode that a newer frame replaced is dropped.
    mutating func decoded(_ frame: String, at now: Double) -> Bool {
        guard frame == decoding else { return false }
        decoding = nil
        shown = frame
        lastChangeAt = now
        return true
    }

    /// The decode failed: the old frame stays and the next offer may try again.
    mutating func failed(_ frame: String) {
        if frame == decoding { decoding = nil }
    }
}

/// The frame of the Moment that plays, beside the sound: a caption with the time and display, the frame with its OCR
/// hit, and a menu to pick another display. Without a capture (`recorded` false) it draws nothing (G-SCR-2); with one,
/// its height stays `height` whether or not a frame is ready, so the dock does not jump.
struct ScreenBesidePlayback: View {
    /// The meeting has screen frames at all (`meeting.screen`'s `recorded`).
    let recorded: Bool
    /// The decoded frame on screen; nil keeps the placeholder at the same size.
    let image: NSImage?
    /// The frame's time on the meeting clock.
    var atSec: Double? = nil
    /// The capture does not cover the time that plays: how far the frame is from it (`TimelineDockModel.apart`). The
    /// caption then says so and the picture dims, because "Screen at 17:28" beside a Moment at 54:35 reads as a fault.
    var apartSec: Double? = nil
    /// The OCR hit that named the spot, drawn as an outline (Vision's normalized box, origin bottom left).
    var hit: MomentFrame.Hit? = nil
    let displays: [ScreenDisplayChoice]
    /// The display shown; nil is the engine's pick (the OCR hit's display, else the shared one; G-SCR-1).
    var selectedDisplay: Int? = nil
    /// The frame's height in the dock. The plan's pick: 150 pt, the dock's zoomed timeline height.
    var height: CGFloat = 150
    /// Follows the playhead (the sketch's "Follows"); off holds the frame.
    var follows = true
    let pickDisplay: (Int?) -> Void
    var toggleFollows: () -> Void = {}
    var openFrame: (() -> Void)? = nil
    var showText: (() -> Void)? = nil

    var body: some View {
        if recorded {
            VStack(alignment: .leading, spacing: 6) {
                header
                if let openFrame {
                    Button(action: openFrame) { frame }
                        .buttonStyle(.plain)
                        .accessibilityLabel(spoken)
                        .accessibilityHint("Open this frame in the recording viewer")
                        .accessibilityIdentifier("meetings.screen.open")
                } else {
                    frame
                }
            }
            .frame(height: height + 50, alignment: .top)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(verbatim: caption).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    .instantTooltip(Self.sentence(atSec: atSec, apartSec: apartSec) ?? "")
                Spacer(minLength: 4)
                if displays.count > 1 {
                MenuButton(style: .genHoverPlain(), items: menuItems) {
                    HStack(spacing: 3) {
                        Image(systemName: "display")
                        Text(verbatim: selectedName)
                        Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
                    }
                    .font(.system(size: 11))
                    .frame(minHeight: 22)
                    .contentShape(Rectangle())
                }
                .instantTooltip("Pick the display the frames come from")
                .accessibilityLabel("Display: \(selectedName)")
                }
            }
            HStack(spacing: 6) {
                KitToggleChip("Follows", isOn: Binding(get: { follows }, set: { _ in toggleFollows() }),
                              hue: .play, size: .small,
                              tooltip: "Follow playback, or hold the current frame",
                              identifier: "meetings.screen.follows")
                if let openFrame {
                    GhostButton("Open frame", symbol: "arrow.up.forward.square", tooltip: "Open this frame in the recording viewer", action: openFrame)
                }
                if let showText {
                    GhostButton("OCR text", symbol: "text.viewfinder", tooltip: "Read and copy all recognized text in this frame", action: showText)
                }
            }
            .font(.system(size: 10))
        }
        .frame(height: 44, alignment: .topLeading)
    }

    private var frame: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.85))
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .overlay { hitOverlay(imageSize: image.size) }
                    .opacity(apartSec == nil ? 1 : 0.45)
                    .accessibilityLabel(hit.map { "\(spoken), showing “\($0.text)”" } ?? spoken)
            } else {
                Label("Reading the frame…", systemImage: "photo")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.secondary.opacity(0.25)))
    }

    private func hitOverlay(imageSize: CGSize) -> some View {
        GeometryReader { proxy in
            if let box = hit?.box {
                let rect = CGRect(x: box.x * proxy.size.width, y: (1 - box.y - box.height) * proxy.size.height,
                                  width: box.width * proxy.size.width, height: box.height * proxy.size.height)
                RoundedRectangle(cornerRadius: 3)
                    .strokeBorder(Color.orange, lineWidth: 1.5)
                    .frame(width: rect.width + 4, height: rect.height + 4)
                    .position(x: rect.midX, y: rect.midY)
            }
        }
        .accessibilityHidden(true)
    }

    private var caption: String { Self.caption(atSec: atSec, apartSec: apartSec) }

    /// What VoiceOver reads for the picture: the full sentence outside the capture, else the caption.
    private var spoken: String { Self.sentence(atSec: atSec, apartSec: apartSec) ?? caption }

    /// "Screen at 54:35"; outside the capture "Frame, 37 min earlier" or "Frame, 55 s later". Short on
    /// purpose: the pane's header is 290 pt wide with its display menu and two buttons, and a longer caption was cut.
    static func caption(atSec: Double?, apartSec: Double?) -> String {
        guard let atSec else { return "Screen" }
        guard let apartSec else { return "Screen at \(MeetingsFormat.clock(atSec))" }
        return apartSec > 0 ? "Frame, \(gap(apartSec)) earlier" : "Frame, \(gap(apartSec)) later"
    }

    /// The caption's full sentence, for the tooltip and VoiceOver; nil inside the capture.
    static func sentence(atSec: Double?, apartSec: Double?) -> String? {
        guard let atSec, let apartSec else { return nil }
        let at = MeetingsFormat.clock(atSec)
        let relative = apartSec > 0 ? "before" : "after"
        return "The capture does not cover this spot. This frame is from \(at), \(gap(apartSec)) \(relative) it."
    }

    private static func gap(_ apartSec: Double) -> String {
        abs(apartSec) < 90 ? "\(Int(abs(apartSec).rounded())) s" : "\(Int((abs(apartSec) / 60).rounded())) min"
    }

    private var selectedName: String {
        guard let selectedDisplay else { return "Auto" }
        return displays.first { $0.id == selectedDisplay }?.name ?? "Display \(selectedDisplay)"
    }

    private func menuItems() -> [MenuButtonItem] {
        var items: [MenuButtonItem] = [
            .action("Auto (recorded focus, then the hit)", checked: selectedDisplay == nil) { pickDisplay(nil) },
            .divider,
        ]
        items += displays.map { display in
            .action("\(display.name) · \(Plural.count(display.frames, "frame"))", checked: selectedDisplay == display.id) {
                pickDisplay(display.id)
            }
        }
        return items
    }
}
