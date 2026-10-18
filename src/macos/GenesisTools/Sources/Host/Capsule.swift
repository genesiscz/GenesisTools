// Voice capsule face of GenesisTools.app:
//   GenesisTools --capsule [--theme dark|light] [--screen main|<index>] [--position bottom|top]
// Draws a floating pill near the bottom of the screen that shows what `tools jev listen` is
// hearing: ten waveform bars driven by the microphone level, the transcript word by word, and the
// state Jev is in. It reads one JSON event per line on stdin and exits when stdin closes or the
// process receives SIGTERM/SIGINT. Diagnostics go to stderr as single lines prefixed "capsule:".
//
// The window never activates and never takes key focus, because the whole point of the
// Accessibility control stack behind `jev listen` is that the app the user is driving stays
// frontmost. A capsule that stole focus would break every AX press it is narrating.
//
// Geometry, easing and colours are a port of heygent's waveform prototype (option "L", words in
// the capsule) and its boss.py capsule config, so the native overlay and the prototype agree.

import AppKit
import Foundation

private func capsuleLog(_ message: String) {
    FileHandle.standardError.write(Data("capsule: \(message)\n".utf8))
}

private func capsuleUsage() -> Never {
    FileHandle.standardError.write(Data("""
    usage: GenesisTools --capsule [--theme dark|light] [--screen main|<index>] [--position bottom|top]
      reads one JSON event per line on stdin and draws a floating voice capsule
      events: {"kind":"state","state":"idle|listening|thinking|acting|error"}
              {"kind":"level","rms":0.0-1.0}
              {"kind":"partial","text":"..."}   {"kind":"final","text":"..."}
              {"kind":"decision","status":"would|act|hold|abstain|wake|stop","label":"...","probability":0.8}

    """.utf8))
    exit(64)
}

// MARK: - geometry, easing and colours

/// Points, not pixels, so these are already density independent. The numbers come from boss.py
/// (PILL_BARS 10, PILL_BAR_WIDTH 2, PILL_BAR_GAP 2, PILL_PAD 17.5, PILL_HEIGHT 30, CARD_WIDTH 340)
/// and the easing constants from the prototype's `Bars` and `hug` models.
private enum Pill {
    static let bars = 10
    static let barWidth: CGFloat = 2
    static let barGap: CGFloat = 2
    static let barPitch: CGFloat = barWidth + barGap
    static let pad: CGFloat = 17.5
    static let height: CGFloat = 30
    static let cardWidth: CGFloat = 340
    static let edgeMargin: CGFloat = 24
    /// Room around the pill inside the window for the drop shadow's blur.
    static let shadowMargin: CGFloat = 16
    /// 17.5 + 10 bars of 2 pt on a 4 pt pitch + 17.5 = 73 pt, Wispr Flow's recording pill.
    static let compactWidth: CGFloat = pad * 2 + CGFloat(bars) * barWidth + CGFloat(bars - 1) * barGap
    /// With words the strip drops to nine bars, then a 12 pt gap, then the text.
    static let textBars = 9
    static let textX: CGFloat = pad + (CGFloat(textBars) * barPitch - barGap) + 12
    static let barEase: CGFloat = 0.30
    static let waveEvery = 4
    static let barFloor: CGFloat = 0.05
    static let widthEase: CGFloat = 0.22
    static let scrollEase: CGFloat = 0.18
    static let fontSize: CGFloat = 12.5
    /// Seconds a word takes to fade in once it lands.
    static let wordFade = 0.18
    /// The capsule stays up this long after the last thing happened, then fades.
    static let linger = 1.2
    /// A dispatched action shows its label for about two seconds.
    static let actHold = 2.0
    /// A hold/abstain/would decision shows "thinking" only briefly.
    static let thinkHold = 0.9
    static let fadeSeconds = 0.18
    static let frameInterval = 1.0 / 60.0
}

private struct Theme {
    let body: NSColor
    let border: NSColor
    let idle: NSColor
    let listening: NSColor
    let thinking: NSColor
    let acting: NSColor
    let error: NSColor
    let text: NSColor
    let shadow: NSColor

    static func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }

    static let dark = Theme(
        body: rgb(11, 12, 16, 0.98),
        border: NSColor(white: 1, alpha: 0.14),
        idle: rgb(75, 81, 92),
        listening: rgb(242, 244, 247),
        thinking: rgb(154, 163, 178),
        acting: rgb(139, 124, 246),
        error: rgb(248, 113, 113),
        text: rgb(242, 244, 247),
        shadow: NSColor(white: 0, alpha: 0.38))

    static let light = Theme(
        body: rgb(248, 249, 251, 0.98),
        border: NSColor(white: 0, alpha: 0.12),
        idle: rgb(168, 174, 186),
        listening: rgb(28, 30, 34),
        thinking: rgb(110, 118, 132),
        acting: rgb(96, 78, 226),
        error: rgb(197, 48, 48),
        text: rgb(28, 30, 34),
        shadow: NSColor(white: 0, alpha: 0.20))
}

private enum CapsuleState: String {
    case idle
    case listening
    case thinking
    case acting
    case error
}

// MARK: - the event protocol

private enum CapsuleEvent {
    case state(CapsuleState)
    case level(Double)
    case partial(String)
    case final(String)
    case decision(status: String, label: String?, probability: Double?)
}

/// One JSON object per line. An unparseable line, or a kind this face does not know, is reported to
/// stderr once per kind and then dropped: a newer `jev listen` must never be able to kill the
/// overlay by sending an event this build predates.
private struct EventReader {
    private var reportedKinds = Set<String>()

    mutating func parse(_ line: String) -> CapsuleEvent? {
        guard let data = line.data(using: .utf8), !data.isEmpty else {
            return nil
        }

        let parsed = try? JSONSerialization.jsonObject(with: data)
        guard let object = parsed as? [String: Any], let kind = object["kind"] as? String else {
            report("unparseable", line: line)
            return nil
        }

        switch kind {
        case "state":
            guard let raw = object["state"] as? String, let state = CapsuleState(rawValue: raw) else {
                report("state:\(object["state"] as? String ?? "?")", line: line)
                return nil
            }

            return .state(state)
        case "level":
            guard let rms = object["rms"] as? Double else {
                report("level", line: line)
                return nil
            }

            return .level(rms)
        case "partial":
            return .partial(object["text"] as? String ?? "")
        case "final":
            return .final(object["text"] as? String ?? "")
        case "decision":
            let status = object["status"] as? String ?? ""
            return .decision(
                status: status, label: object["label"] as? String, probability: object["probability"] as? Double)
        default:
            report(kind, line: line)
            return nil
        }
    }

    private mutating func report(_ kind: String, line: String) {
        guard reportedKinds.insert(kind).inserted else {
            return
        }

        capsuleLog("ignoring unknown event kind '\(kind)' (first occurrence: \(line.prefix(120)))")
    }
}

// MARK: - the waveform

/// A faithful port of the prototype's `Bars`: ten slots of recent microphone level scrolling right
/// to left, each drawn slot eased toward its target so a loud syllable does not snap.
private struct Bars {
    private var wave: [CGFloat]
    private var render: [CGFloat]
    private var accum: Double = 0
    private var samples = 0
    private var peak: Double = 0
    private var frame = 0

    init() {
        wave = Array(repeating: Pill.barFloor, count: Pill.bars)
        render = wave
    }

    mutating func sample(_ level: Double) {
        accum += level
        samples += 1
        peak = max(peak, level)
    }

    mutating func reset() {
        wave = Array(repeating: Pill.barFloor, count: Pill.bars)
        accum = 0
        samples = 0
        peak = 0
    }

    /// Called once per 60 Hz frame. The scroll advances every fourth frame (15 Hz), which is what
    /// makes ten slots read as about 0.7 s of history.
    mutating func step() {
        for index in render.indices {
            render[index] += (wave[index] - render[index]) * Pill.barEase
        }

        frame += 1
        guard frame % Pill.waveEvery == 0 else {
            return
        }

        let mean = samples > 0 ? accum / Double(samples) : 0
        wave.removeFirst()
        wave.append(max(Pill.barFloor, CGFloat(0.72 * mean + 0.28 * peak)))
        accum = 0
        samples = 0
        peak = 0
    }

    /// Heights are smoothed across neighbours so the strip reads as one waveform rather than ten
    /// independent meters.
    func heights(slots: Int) -> [CGFloat] {
        let raw = Array(render.suffix(slots))
        return raw.indices.map { index in
            let before = raw[max(index - 1, 0)]
            let after = raw[min(index + 1, raw.count - 1)]
            let smoothed = (before + 2 * raw[index] + after) / 4
            return max(4, smoothed * Pill.height * 0.40)
        }
    }
}

// MARK: - the words

private struct CapsuleWord {
    let text: String
    let landedAt: Double
}

/// The transcript as timed words. A partial that revises its tail re-times only the words that
/// actually changed, so a correction does not make the whole line flash.
private struct WordTrack {
    private(set) var words: [CapsuleWord] = []

    mutating func update(text: String, now: Double) {
        let incoming = text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).map(String.init)
        var shared = 0
        while shared < words.count, shared < incoming.count, words[shared].text == incoming[shared] {
            shared += 1
        }

        words.removeSubrange(shared...)
        for word in incoming[shared...] {
            words.append(CapsuleWord(text: word, landedAt: now))
        }
    }

    mutating func clear() {
        words.removeAll()
    }
}

// MARK: - the model

/// Everything the view draws, and the only place the presentation rules live.
///
/// Ported from the conductor's `PresentationCoordinator`, reduced to the one region this overlay
/// owns: the user's own turn outranks anything the system wants to show, a dispatched action holds
/// the capsule for a moment so the user can read what was pressed, a weak status (thinking) never
/// survives the user starting to talk again, and idle is recomputed rather than restored, so a
/// transcript that has gone stale does not come back when the next thing finishes.
private final class CapsuleModel {
    private(set) var state: CapsuleState = .idle
    private(set) var bars = Bars()
    private(set) var track = WordTrack()
    private(set) var actionLabel: String?
    /// When the label arrived. It is stamped once, not per frame: the word fades in against this,
    /// and a time that moved with the clock would hold the label at zero alpha forever.
    private(set) var actionLabelAt: Double = 0
    private(set) var width: CGFloat = Pill.compactWidth
    private(set) var scroll: CGFloat = 0
    private(set) var alpha: CGFloat = 0
    private(set) var now: Double = 0

    private var lastActivity: Double = -1e9
    private var stateUntil: Double?
    private var visible = false
    private let maxWidth: CGFloat

    init(maxWidth: CGFloat) {
        self.maxWidth = maxWidth
    }

    var isSettledHidden: Bool {
        !visible && alpha <= 0.001
    }

    func apply(_ event: CapsuleEvent, now: Double) {
        self.now = now
        switch event {
        case .state(let next):
            applyState(next, now: now)
        case .level(let rms):
            bars.sample(min(max(rms, 0), 1))
            if visible {
                lastActivity = now
            }
        case .partial(let text), .final(let text):
            applyTranscript(text, now: now)
        case .decision(let status, let label, _):
            applyDecision(status: status, label: label, now: now)
        }
    }

    private func applyState(_ next: CapsuleState, now: Double) {
        if next == .idle {
            // Idle is a request to fade, not an instruction to blank the pill: the words stay
            // readable for the linger so a finished sentence is not snatched away.
            stateUntil = nil
            state = .idle
            return
        }

        show(now: now)
        state = next
        stateUntil = nil
        actionLabel = nil
    }

    private func applyTranscript(_ text: String, now: Double) {
        // The user talking is the strongest signal there is; it ends a held action or a thinking
        // state immediately.
        show(now: now)
        if state != .listening {
            state = .listening
            actionLabel = nil
            stateUntil = nil
        }

        track.update(text: text, now: now)
    }

    private func applyDecision(status: String, label: String?, now: Double) {
        switch status {
        case "act":
            show(now: now)
            state = .acting
            actionLabel = label
            actionLabelAt = now
            stateUntil = now + Pill.actHold
        case "stop":
            state = .idle
            stateUntil = nil
        case "hold", "abstain", "would", "wake":
            show(now: now)
            state = .thinking
            actionLabel = nil
            stateUntil = now + Pill.thinkHold
        default:
            capsuleLog("ignoring decision status '\(status)'")
        }
    }

    private func show(now: Double) {
        if !visible {
            bars.reset()
        }

        visible = true
        lastActivity = now
    }

    /// One 60 Hz frame of the model: state expiry, the linger, the fade, the bars and the hug.
    func step(now: Double, contentWidth: CGFloat) {
        self.now = now
        if let until = stateUntil, now >= until {
            // A held action and a weak thinking state both expire back to listening, never to a
            // state of their own: what comes next is whatever the user says next.
            stateUntil = nil
            state = .listening
            actionLabel = nil
        }

        if visible, state == .idle || now - lastActivity > Pill.linger {
            visible = false
        }

        let targetAlpha: CGFloat = visible ? 1 : 0
        let alphaStep = CGFloat(Pill.frameInterval / Pill.fadeSeconds)
        alpha += max(-alphaStep, min(alphaStep, targetAlpha - alpha))
        if !visible, alpha <= 0.001 {
            alpha = 0
            track.clear()
            actionLabel = nil
            bars.reset()
            width = Pill.compactWidth
            scroll = 0
            return
        }

        bars.step()
        hug(contentWidth: contentWidth)
    }

    /// The capsule hugs its words between the card width and the screen cap, then the words scroll.
    private func hug(contentWidth: CGFloat) {
        let target = contentWidth > 0
            ? min(maxWidth, max(Pill.cardWidth, Pill.textX + contentWidth + Pill.pad))
            : Pill.compactWidth
        width += (target - width) * Pill.widthEase
        let room = maxWidth - Pill.textX - Pill.pad
        let want = contentWidth > 0 ? max(0, contentWidth - room) : 0
        scroll += (want - scroll) * Pill.scrollEase
    }

    func tint(_ theme: Theme) -> NSColor {
        switch state {
        case .idle: return theme.idle
        case .listening: return theme.listening
        case .thinking: return theme.thinking
        case .acting: return theme.acting
        case .error: return theme.error
        }
    }
}

// MARK: - the view

private final class CapsuleView: NSView {
    private let model: CapsuleModel
    private let theme: Theme
    private let font = NSFont.systemFont(ofSize: Pill.fontSize, weight: .medium)
    private var spaceWidth: CGFloat = 0

    init(model: CapsuleModel, theme: Theme, frame: NSRect) {
        self.model = model
        self.theme = theme
        super.init(frame: frame)
        spaceWidth = (" " as NSString).size(withAttributes: [.font: font]).width
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("CapsuleView is created in code only")
    }

    /// The label the capsule is currently showing: the chosen action while acting, the transcript
    /// otherwise. Measured before the model steps, so the hug has this frame's width to aim at.
    func contentRun() -> [(word: CapsuleWord, x: CGFloat, width: CGFloat)] {
        let words: [CapsuleWord] = if let label = model.actionLabel, model.state == .acting {
            [CapsuleWord(text: label, landedAt: model.actionLabelAt)]
        } else {
            model.track.words
        }

        var run: [(word: CapsuleWord, x: CGFloat, width: CGFloat)] = []
        var x: CGFloat = 0
        for word in words {
            let width = (word.text as NSString).size(withAttributes: [.font: font]).width
            run.append((word, x, width))
            x += width + spaceWidth
        }

        return run
    }

    func contentWidth(_ run: [(word: CapsuleWord, x: CGFloat, width: CGFloat)]) -> CGFloat {
        guard let last = run.last else {
            return 0
        }

        return last.x + last.width
    }

    override func draw(_ dirtyRect: NSRect) {
        guard model.alpha > 0.001, let context = NSGraphicsContext.current else {
            return
        }

        let run = contentRun()
        let width = model.width
        let originX = (bounds.width - width) / 2
        let originY = (bounds.height - Pill.height) / 2
        let body = NSRect(x: originX, y: originY, width: width, height: Pill.height)
        context.saveGraphicsState()
        context.compositingOperation = .sourceOver
        drawBody(body, alpha: model.alpha)
        // `open` is how far the capsule has grown past its compact width; the bar strip slides from
        // the centre of the pill to its left padding as the words take the middle, and drops its
        // tenth slot to make the 12 pt gap before the text.
        let open = min(max((width - Pill.compactWidth) / 80, 0), 1)
        let slots = open > 0.5 ? Pill.textBars : Pill.bars
        let span = CGFloat(slots) * Pill.barPitch - Pill.barGap
        let centred = (width - span) / 2
        let barsStart = originX + centred + (Pill.pad - centred) * open
        drawBars(startX: barsStart, centerY: originY + Pill.height / 2, slots: slots)
        drawWords(run, body: body, open: open)
        context.restoreGraphicsState()
    }

    private func drawBody(_ rect: NSRect, alpha: CGFloat) {
        let path = NSBezierPath(roundedRect: rect, xRadius: Pill.height / 2, yRadius: Pill.height / 2)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = theme.shadow.withAlphaComponent(theme.shadow.alphaComponent * alpha)
        shadow.shadowBlurRadius = 14
        shadow.shadowOffset = NSSize(width: 0, height: -4)
        shadow.set()
        theme.body.withAlphaComponent(theme.body.alphaComponent * alpha).setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
        let border = NSBezierPath(
            roundedRect: rect.insetBy(dx: 0.5, dy: 0.5),
            xRadius: (Pill.height - 1) / 2, yRadius: (Pill.height - 1) / 2)
        theme.border.withAlphaComponent(theme.border.alphaComponent * alpha).setStroke()
        border.lineWidth = 1
        border.stroke()
    }

    private func drawBars(startX: CGFloat, centerY: CGFloat, slots: Int) {
        let colour = model.tint(theme).withAlphaComponent(0.95 * model.alpha)
        colour.setFill()
        for (index, height) in model.bars.heights(slots: slots).enumerated() {
            let rect = NSRect(
                x: startX + CGFloat(index) * Pill.barPitch, y: centerY - height / 2,
                width: Pill.barWidth, height: height)
            NSBezierPath(roundedRect: rect, xRadius: 1, yRadius: 1).fill()
        }
    }

    private func drawWords(
        _ run: [(word: CapsuleWord, x: CGFloat, width: CGFloat)], body: NSRect, open: CGFloat
    ) {
        guard !run.isEmpty, open > 0.01 else {
            return
        }

        let left = body.minX + Pill.textX
        let right = body.maxX - 12
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: NSRect(x: left - 8, y: body.minY, width: max(0, right - left + 8), height: body.height))
            .addClip()
        let colour = model.state == .acting ? theme.acting : theme.text
        let lineHeight = ("Hg" as NSString).size(withAttributes: [.font: font]).height
        for item in run {
            let x = left + item.x - model.scroll
            let landed = min(max((model.now - item.word.landedAt) / Pill.wordFade, 0), 1)
            let edge = model.scroll > 0.5 ? min(max((x + item.width - left) / 26, 0), 1) : 1
            let alpha = 0.95 * model.alpha * CGFloat(landed) * edge
            guard alpha > 0.01 else {
                continue
            }

            let point = NSPoint(x: x + CGFloat(1 - landed) * 5, y: body.midY - lineHeight / 2)
            (item.word.text as NSString).draw(
                at: point, withAttributes: [.font: font, .foregroundColor: colour.withAlphaComponent(alpha)])
        }

        NSGraphicsContext.restoreGraphicsState()
    }
}

// MARK: - the window and the run loop

private final class CapsuleController {
    private let panel: NSPanel
    private let view: CapsuleView
    private let model: CapsuleModel
    private var timer: Timer?
    private let started = Date()

    init(theme: Theme, screen: NSScreen, position: String) {
        let visible = screen.visibleFrame
        let maxWidth = min(visible.width * 0.6, max(Pill.cardWidth, visible.width - 2 * Pill.edgeMargin))
        model = CapsuleModel(maxWidth: maxWidth)
        let windowWidth = maxWidth + 2 * Pill.shadowMargin
        let windowHeight = Pill.height + 2 * Pill.shadowMargin
        let x = visible.midX - windowWidth / 2
        let y = position == "top"
            ? visible.maxY - Pill.edgeMargin - windowHeight
            : visible.minY + Pill.edgeMargin
        let frame = NSRect(x: x.rounded(), y: y.rounded(), width: windowWidth, height: windowHeight)
        panel = NSPanel(
            contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        view = CapsuleView(model: model, theme: theme, frame: NSRect(origin: .zero, size: frame.size))
        configurePanel(frame: frame)
    }

    /// Non-activating, borderless, mouse-transparent and on every space: the capsule must never take
    /// focus from the app `jev listen` is pressing buttons in.
    private func configurePanel(frame: NSRect) {
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.hasShadow = false
        panel.backgroundColor = .clear
        panel.level = .statusBar
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.contentView = view
        panel.setFrame(frame, display: false)
    }

    func apply(_ event: CapsuleEvent) {
        model.apply(event, now: Date().timeIntervalSince(started))
        startTicking()
    }

    /// The timer runs only while there is something to draw. An overlay that ticks at 60 Hz with
    /// nothing on screen is the exact idle cost this repo measured and forbids.
    private func startTicking() {
        guard timer == nil else {
            return
        }

        panel.orderFrontRegardless()
        let timer = Timer(timeInterval: Pill.frameInterval, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func tick() {
        let run = view.contentRun()
        model.step(now: Date().timeIntervalSince(started), contentWidth: view.contentWidth(run))
        view.needsDisplay = true
        guard model.isSettledHidden else {
            return
        }

        timer?.invalidate()
        timer = nil
        panel.orderOut(nil)
    }

    func close() {
        timer?.invalidate()
        timer = nil
        panel.orderOut(nil)
    }
}

/// Reads stdin on its own thread. `readLine` blocks until a line or EOF arrives, so this waits on
/// the event rather than polling for it, and EOF is the documented way the parent asks us to stop.
private func readEvents(onEvent: @escaping (CapsuleEvent) -> Void, onEnd: @escaping () -> Void) {
    let thread = Thread {
        var reader = EventReader()
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty else {
                continue
            }

            if let event = reader.parse(line) {
                DispatchQueue.main.async { onEvent(event) }
            }
        }

        DispatchQueue.main.async { onEnd() }
    }
    thread.name = "capsule-stdin"
    thread.start()
}

func runCapsule(_ args: [String]) -> Never {
    var theme = Theme.dark
    var screenChoice = "main"
    var position = "bottom"
    var index = 0
    while index < args.count {
        switch args[index] {
        case "--theme":
            index += 1
            guard index < args.count else { capsuleUsage() }
            switch args[index] {
            case "dark": theme = Theme.dark
            case "light": theme = Theme.light
            default: capsuleUsage()
            }
        case "--screen":
            index += 1
            guard index < args.count else { capsuleUsage() }
            screenChoice = args[index]
        case "--position":
            index += 1
            guard index < args.count, args[index] == "bottom" || args[index] == "top" else { capsuleUsage() }
            position = args[index]
        case "--help", "-h":
            capsuleUsage()
        default:
            capsuleUsage()
        }
        index += 1
    }

    let screen = resolveScreen(screenChoice)
    let app = NSApplication.shared
    // .accessory keeps the bundle out of the Dock and the app switcher, and stops the capsule from
    // ever becoming the active application.
    app.setActivationPolicy(.accessory)
    let controller = CapsuleController(theme: theme, screen: screen, position: position)
    capsuleLog("capsule up on \(Int(screen.frame.width))x\(Int(screen.frame.height)) at the \(position)")
    installTerminationHandlers(controller: controller)
    readEvents(onEvent: { controller.apply($0) }, onEnd: {
        capsuleLog("stdin closed; exiting")
        controller.close()
        NSApp.terminate(nil)
    })
    app.run()
    exit(0)
}

private func resolveScreen(_ choice: String) -> NSScreen {
    let screens = NSScreen.screens
    if choice != "main", let wanted = Int(choice), wanted >= 0, wanted < screens.count {
        return screens[wanted]
    }

    if choice != "main" {
        capsuleLog("screen '\(choice)' is not one of \(screens.count) screens; using the main one")
    }

    return NSScreen.main ?? screens[0]
}

private var terminationSources: [DispatchSourceSignal] = []

private func installTerminationHandlers(controller: CapsuleController) {
    for number in [SIGTERM, SIGINT] {
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
        source.setEventHandler {
            capsuleLog("signal \(number); exiting")
            controller.close()
            NSApp.terminate(nil)
        }
        source.resume()
        terminationSources.append(source)
    }
}
