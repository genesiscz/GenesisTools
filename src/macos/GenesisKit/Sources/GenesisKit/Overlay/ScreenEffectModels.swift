import AppKit
import Foundation

/// How a screen effect changes the screen.
public enum ScreenEffectStyle: String, CaseIterable, Codable, Sendable {
    /// Darkened edges; the middle stays clear.
    case vignette
    /// No tint at all: only the message pill and the camera bubble.
    case transparent
    /// A warm filter over everything.
    case sepia
    /// Everything behind is blurred. Turns into `dim` under Reduce Transparency.
    case blur
    /// Everything behind is darkened evenly.
    case dim
    /// A coloured glow along the screen's edges (a disk alert).
    case edgeGlow

    public var title: String {
        switch self {
        case .vignette: return "Vignette"
        case .transparent: return "Transparent"
        case .sepia: return "Sepia"
        case .blur: return "Blur"
        case .dim: return "Dim"
        case .edgeGlow: return "Edge glow"
        }
    }

    public var detail: String {
        switch self {
        case .vignette: return "Darkens the edges of the screen and keeps the middle clear."
        case .transparent: return "No tint: only the message and the camera bubble show."
        case .sepia: return "A warm filter over the whole screen."
        case .blur: return "Blurs what is behind it. Reduce Transparency shows a dim instead."
        case .dim: return "Darkens the whole screen evenly."
        case .edgeGlow: return "A coloured glow along the edges of the screen."
        }
    }

    public var symbol: String {
        switch self {
        case .vignette: return "circle.dashed"
        case .transparent: return "rectangle.dashed"
        case .sepia: return "camera.filters"
        case .blur: return "drop.halffull"
        case .dim: return "moon"
        case .edgeGlow: return "rectangle.inset.filled"
        }
    }

    /// The style actually drawn: blur becomes dim when transparency must be reduced.
    public func effective(reduceTransparency: Bool) -> ScreenEffectStyle {
        self == .blur && reduceTransparency ? .dim : self
    }
}

/// Which screens show the effect.
public enum ScreenEffectTarget: String, CaseIterable, Codable, Sendable {
    case allScreens
    case mainScreen
    case cursorScreen

    public var title: String {
        switch self {
        case .allScreens: return "All screens"
        case .mainScreen: return "Main screen"
        case .cursorScreen: return "Screen with the cursor"
        }
    }
}

/// The text and symbol of the pill a screen effect shows ("Sit up straight").
public struct ScreenEffectMessage: Equatable, Sendable {
    public var text: String
    public var symbol: String?

    public init(_ text: String, symbol: String? = nil) {
        self.text = text
        self.symbol = symbol
    }
}

/// What a screen effect does while the screen is captured (a share or a recording, see `ScreenCaptureDetector`).
public enum ScreenCaptureBehavior: String, CaseIterable, Codable, Sendable {
    /// Everything shows. Viewers of a share see the tint, the message and the camera bubble.
    case showEverything
    /// The camera bubble (the user's face) hides; the tint and the message still show. The default.
    case hideCameraBubble
    /// The camera bubble and the message hide; the tint still shows.
    case hideCameraBubbleAndMessage
    /// Nothing shows. The effect stays on (its timeout keeps counting) and appears when the capture ends.
    case holdBack

    public var title: String {
        switch self {
        case .showEverything: return "Show everything"
        case .hideCameraBubble: return "Hide the camera"
        case .hideCameraBubbleAndMessage: return "Hide the camera and the message"
        case .holdBack: return "Show nothing"
        }
    }
}

/// Everything a `ScreenEffectsController` draws and how it behaves.
public struct ScreenEffectConfiguration: Equatable {
    public var style: ScreenEffectStyle
    /// 0...2 (×); 1 is the designed strength.
    public var intensity: Double
    /// The edge glow's colour.
    public var glow: ChartColor
    public var target: ScreenEffectTarget
    /// The pill; nil shows none.
    public var message: ScreenEffectMessage?
    /// Cover the menu bar and the Dock too (the screen's whole frame), or only the visible frame.
    public var coversMenuBar: Bool
    /// Seconds to reach full strength; instant under Reduce Motion.
    public var rampIn: TimeInterval
    /// Seconds to clear.
    public var rampOut: TimeInterval
    /// The longest the effect stays up before it hides itself and reports a timeout; nil is no limit.
    public var maximumDuration: TimeInterval?
    /// The panels' `NSWindow.sharingType`. `.none` keeps them out of the legacy `CGWindowList` captures only:
    /// ScreenCaptureKit (Zoom, Meet, Teams, QuickTime and the screenshot tools on macOS 15 and later) ignores it.
    /// What hides during those is `duringScreenCapture`.
    public var sharingType: NSWindow.SharingType
    /// What hides while the screen is captured. The default hides the camera bubble.
    public var duringScreenCapture: ScreenCaptureBehavior

    public init(
        style: ScreenEffectStyle = .vignette, intensity: Double = 1, glow: ChartColor = .init(red: 0.96, green: 0.38, blue: 0.40),
        target: ScreenEffectTarget = .allScreens, message: ScreenEffectMessage? = nil, coversMenuBar: Bool = true,
        rampIn: TimeInterval = 2.0, rampOut: TimeInterval = 0.3, maximumDuration: TimeInterval? = 180,
        sharingType: NSWindow.SharingType = .none, duringScreenCapture: ScreenCaptureBehavior = .hideCameraBubble
    ) {
        self.style = style
        self.intensity = intensity
        self.glow = glow
        self.target = target
        self.message = message
        self.coversMenuBar = coversMenuBar
        self.rampIn = rampIn
        self.rampOut = rampOut
        self.maximumDuration = maximumDuration
        self.sharingType = sharingType
        self.duringScreenCapture = duringScreenCapture
    }

    /// `intensity` clamped to 0...2 (a stored value from an older build can be anything).
    public var clampedIntensity: Double { intensity.isFinite ? min(2, max(0, intensity)) : 1 }
}

/// A display as the effect geometry sees it, so geometry and target choice are testable without real screens.
public struct ScreenEffectScreen: Equatable, Sendable {
    public let id: String
    /// The whole screen, in global (bottom-left origin) coordinates.
    public let frame: CGRect
    /// Without the menu bar and the Dock.
    public let visibleFrame: CGRect

    public init(id: String, frame: CGRect, visibleFrame: CGRect) {
        self.id = id
        self.frame = frame
        self.visibleFrame = visibleFrame
    }

    @MainActor
    public init(_ screen: NSScreen) {
        let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        self.init(
            id: number.map { "display-\($0.uint32Value)" } ?? "screen-\(Int(screen.frame.minX))-\(Int(screen.frame.minY))",
            frame: screen.frame, visibleFrame: screen.visibleFrame)
    }
}

/// Which screens a target covers, where each effect panel goes, and where the pill and the camera bubble sit.
public enum ScreenEffectGeometry {
    /// The screens `target` covers: all of them, the main one (the first, as AppKit orders them), or the one the
    /// cursor is on (the main one when the cursor is on none).
    public static func screens(
        for target: ScreenEffectTarget, among screens: [ScreenEffectScreen], cursor: CGPoint
    ) -> [ScreenEffectScreen] {
        guard let main = screens.first else { return [] }
        switch target {
        case .allScreens: return screens
        case .mainScreen: return [main]
        case .cursorScreen: return [screens.first { $0.frame.contains(cursor) } ?? main]
        }
    }

    /// The screen that holds the camera bubble: the cursor's screen for that target, else the main screen.
    public static func bubbleScreen(
        for target: ScreenEffectTarget, among screens: [ScreenEffectScreen], cursor: CGPoint
    ) -> ScreenEffectScreen? {
        target == .cursorScreen
            ? Self.screens(for: target, among: screens, cursor: cursor).first : screens.first
    }

    /// The effect panel's frame on `screen`.
    public static func panelFrame(on screen: ScreenEffectScreen, coversMenuBar: Bool) -> CGRect {
        coversMenuBar ? screen.frame : screen.visibleFrame
    }

    /// Side of the camera bubble, and its gap from the visible frame's corner.
    public static let bubbleSize: CGFloat = 176
    public static let bubbleMargin: CGFloat = 28

    /// The camera bubble's frame: the bottom-right corner of the visible frame.
    public static func bubbleFrame(on screen: ScreenEffectScreen) -> CGRect {
        let visible = screen.visibleFrame
        return CGRect(
            x: visible.maxX - bubbleMargin - bubbleSize, y: visible.minY + bubbleMargin, width: bubbleSize,
            height: bubbleSize)
    }

    /// Where the pill's centre sits inside a panel of `panelSize`: a third of the way down the visible part.
    public static func pillCenter(panel: CGRect, visible: CGRect) -> CGPoint {
        let top = panel.maxY - visible.maxY
        let height = visible.height
        return CGPoint(x: visible.midX - panel.minX, y: top + height * 0.3)
    }
}

/// The show, hide, timeout and kill-switch rules of a screen effect, without windows or timers.
public struct ScreenEffectMachine: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case hidden
        case shown(since: Date, preview: Bool)
    }

    public enum ShowResult: Equatable, Sendable {
        case presented
        /// A preview on screen became a real effect; nothing new appears.
        case promoted
        case alreadyShown
        case suppressed(until: Date)
    }

    public private(set) var phase: Phase = .hidden
    public private(set) var suppressedUntil: Date?

    public init() {}

    public var isShown: Bool { if case .shown = phase { return true } else { return false } }
    public var isPreview: Bool { if case .shown(_, let preview) = phase { return preview } else { return false } }

    public func isSuppressed(at now: Date) -> Bool { suppressedUntil.map { now < $0 } ?? false }

    /// A real show, or a preview. A real show over a preview turns it real (and restarts the clock); a preview never
    /// replaces a real show. Nothing shows while suppressed, a preview included.
    public mutating func show(at now: Date, preview: Bool = false) -> ShowResult {
        if let until = suppressedUntil, now < until { return .suppressed(until: until) }
        if suppressedUntil != nil { suppressedUntil = nil }
        switch phase {
        case .hidden:
            phase = .shown(since: now, preview: preview)
            return .presented
        case .shown(_, let wasPreview):
            if wasPreview, !preview {
                phase = .shown(since: now, preview: false)
                return .promoted
            }
            return .alreadyShown
        }
    }

    /// Hides; true when something was on screen.
    @discardableResult
    public mutating func hide() -> Bool {
        guard isShown else { return false }
        phase = .hidden
        return true
    }

    /// The kill switch: hides now and refuses every show until `date`.
    @discardableResult
    public mutating func suppress(until date: Date) -> Bool {
        suppressedUntil = date
        return hide()
    }

    public mutating func clearSuppression() { suppressedUntil = nil }

    /// When the effect must hide itself: `maximumDuration` after it was shown, or nil when it has no limit or is hidden.
    public func deadline(maximumDuration: TimeInterval?) -> Date? {
        guard case .shown(let since, _) = phase, let maximumDuration else { return nil }
        return since.addingTimeInterval(maximumDuration)
    }
}
