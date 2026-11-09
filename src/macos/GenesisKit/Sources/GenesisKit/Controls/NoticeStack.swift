import Observation
import SwiftUI

// A stack of notices that floats over a view's content. Each notice keeps its own buttons (an Undo carries what it
// takes back) and its own time; the pointer over the stack stops every clock, so nothing leaves or moves under it;
// an error stays until it is closed. One notice used to replace the last one and sit in the layout, so each answer
// pushed the content down and took the Undo of the answer before (Meetings R15, R31, 2026-11-09).

// MARK: - Time

/// A timer a `NoticeClock` started; `cancel()` stops it before it fires.
@MainActor
public final class NoticeTimer {
    private var onCancel: (() -> Void)?

    public init(onCancel: @escaping () -> Void) {
        self.onCancel = onCancel
    }

    public func cancel() {
        onCancel?()
        onCancel = nil
    }
}

/// The time a notice stack counts in. The app uses `SystemNoticeClock`; a test moves a `ManualNoticeClock` by hand.
@MainActor
public protocol NoticeClock: AnyObject {
    /// Seconds on a clock that only goes forward.
    var now: TimeInterval { get }
    /// Calls `action` once, `seconds` from now, unless the timer is cancelled first.
    func schedule(after seconds: TimeInterval, _ action: @escaping @MainActor () -> Void) -> NoticeTimer
}

/// The real clock: uptime, and a main-actor task per timer.
@MainActor
public final class SystemNoticeClock: NoticeClock {
    public static let shared = SystemNoticeClock()

    public init() {}

    public var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    public func schedule(after seconds: TimeInterval, _ action: @escaping @MainActor () -> Void) -> NoticeTimer {
        let task = Task { @MainActor in
            try? await Task.sleep(for: .seconds(max(0, seconds)))
            guard !Task.isCancelled else { return }
            action()
        }
        return NoticeTimer { task.cancel() }
    }
}

/// A clock that moves only when `advance(by:)` says so, for tests and previews. Timers due within the step fire in
/// the order they are due, each with `now` at its own time.
@MainActor
public final class ManualNoticeClock: NoticeClock {
    public private(set) var now: TimeInterval
    private var pending: [(id: Int, at: TimeInterval, action: @MainActor () -> Void)] = []
    private var nextID = 0

    public init(now: TimeInterval = 0) {
        self.now = now
    }

    /// How many timers wait to fire.
    public var pendingCount: Int { pending.count }

    public func schedule(after seconds: TimeInterval, _ action: @escaping @MainActor () -> Void) -> NoticeTimer {
        nextID += 1
        let id = nextID
        pending.append((id, now + max(0, seconds), action))
        return NoticeTimer { [weak self] in self?.pending.removeAll { $0.id == id } }
    }

    public func advance(by seconds: TimeInterval) {
        let target = now + seconds
        while let next = pending.filter({ $0.at <= target }).min(by: { ($0.at, $0.id) < ($1.at, $1.id) }) {
            pending.removeAll { $0.id == next.id }
            now = max(now, next.at)
            next.action()
        }
        now = target
    }
}

// MARK: - Notices

/// How long the notices of a stack stay when a notice does not name its own time.
public struct NoticeStackTiming: Equatable, Sendable {
    /// A notice with a button (Undo, Show): long enough to read it and reach the button.
    public var actionSeconds: Double
    /// A notice without a button, a success or a warning.
    public var plainSeconds: Double

    public init(actionSeconds: Double, plainSeconds: Double) {
        self.actionSeconds = actionSeconds
        self.plainSeconds = plainSeconds
    }

    /// 30 s for a notice with a button (Meetings R15: "an overlay that stays about 30 s with an Undo button"); six
    /// seconds for one without, the time a `NoticePill` on its own fades after.
    public static let standard = NoticeStackTiming(actionSeconds: 30, plainSeconds: 6)
}

/// One notice in a `NoticeStackModel`.
public struct StackedNotice: Identifiable {
    public struct ID: Hashable, Sendable {
        private let raw = UUID()
        public init() {}
    }

    /// How long the notice stays.
    public enum Lasting: Equatable, Sendable {
        /// An error stays until it is closed; a notice with a button stays the stack's `actionSeconds`; any other
        /// stays its `plainSeconds`.
        case automatic
        case seconds(Double)
        case untilDismissed
    }

    /// One button of a notice, and what the notice does once it is pressed.
    public struct Action {
        public enum AfterPress: Equatable, Sendable {
            /// The notice goes, then the action runs (Retry: its result is a notice of its own).
            case dismiss
            /// The notice stays and keeps its time (Show in Finder).
            case keep
            /// The notice stays in its place with these words and no buttons, and its clock stops, until the action's
            /// result replaces it (`push(_:replacing:)`) or it is closed (Undo: "Undoing…").
            case wait(String)
        }

        public let label: String
        public let symbol: String?
        /// Asks inside the notice before the action runs.
        public let confirm: NoticeFix.Confirmation?
        public let afterPress: AfterPress
        /// Gets the notice's id, so the result can replace it in place.
        public let perform: @MainActor (StackedNotice.ID) -> Void

        public init(_ label: String, symbol: String? = nil, confirm: NoticeFix.Confirmation? = nil,
                    afterPress: AfterPress = .dismiss, perform: @escaping @MainActor (StackedNotice.ID) -> Void) {
            self.label = label
            self.symbol = symbol
            self.confirm = confirm
            self.afterPress = afterPress
            self.perform = perform
        }

        /// Takes back what the notice reports. The notice waits in its place until the result replaces it.
        public static func undo(_ perform: @escaping @MainActor (StackedNotice.ID) -> Void) -> Action {
            Action("Undo", symbol: "arrow.uturn.backward", afterPress: .wait("Undoing…"), perform: perform)
        }

        /// Runs the failed action again; the error goes, and the new attempt reports on its own.
        public static func retry(_ perform: @escaping @MainActor () -> Void) -> Action {
            Action("Retry", symbol: "arrow.clockwise", afterPress: .dismiss) { _ in perform() }
        }
    }

    /// Set by the stack when this notice replaces another: it keeps the replaced one's id and place.
    public internal(set) var id: ID
    public var text: String
    public var detail: String?
    /// The full message behind "Details".
    public var more: String?
    public var tone: NoticePill.Tone
    public var actions: [Action]
    public var lasting: Lasting

    public init(id: ID = ID(), text: String, detail: String? = nil, more: String? = nil, tone: NoticePill.Tone = .success,
                actions: [Action] = [], lasting: Lasting = .automatic) {
        self.id = id
        self.text = text
        self.detail = detail
        self.more = more
        self.tone = tone
        self.actions = actions
        self.lasting = lasting
    }
}

/// The notices a view shows over its content, oldest first. `push` returns the id that a later `push(_:replacing:)`
/// or `dismiss` names. Each notice counts its own time on the injected clock; `setPaused(true)` (the pointer over the
/// stack) stops every clock, and `setPaused(false)` gives each notice the time it had left.
@Observable
@MainActor
public final class NoticeStackModel {
    public private(set) var notices: [StackedNotice] = []
    /// Notices that wait for the result of a pressed action, with the words they show meanwhile.
    public private(set) var waiting: [StackedNotice.ID: String] = [:]
    /// The pointer is over the stack: no notice leaves.
    public private(set) var isPaused = false

    private struct Run {
        /// Seconds left; nil: the notice stays until it is closed.
        var remaining: TimeInterval?
        /// When the clock last started counting; nil while it does not count.
        var startedAt: TimeInterval?
        var timer: NoticeTimer?
    }

    @ObservationIgnored private let clock: NoticeClock
    @ObservationIgnored private let timing: @MainActor () -> NoticeStackTiming
    @ObservationIgnored private let announces: Bool
    @ObservationIgnored private var runs: [StackedNotice.ID: Run] = [:]

    /// `clock` defaults to `SystemNoticeClock.shared`. `timing` is read at each push, so a changed setting applies to
    /// the next notice. `announces` posts each new notice to VoiceOver.
    public init(clock: NoticeClock? = nil,
                timing: @escaping @MainActor () -> NoticeStackTiming = { .standard }, announces: Bool = true) {
        self.clock = clock ?? SystemNoticeClock.shared
        self.timing = timing
        self.announces = announces
    }

    public func notice(_ id: StackedNotice.ID) -> StackedNotice? {
        notices.first { $0.id == id }
    }

    public func contains(_ id: StackedNotice.ID) -> Bool {
        notices.contains { $0.id == id }
    }

    /// Adds `notice` on top of the stack, or, when `replacing` names a notice still on screen, puts it in that one's
    /// place with that one's id and a fresh clock. Returns the id the notice has in the stack.
    @discardableResult
    public func push(_ notice: StackedNotice, replacing replaced: StackedNotice.ID? = nil) -> StackedNotice.ID {
        var notice = notice
        if let replaced, let index = notices.firstIndex(where: { $0.id == replaced }) {
            stopClock(replaced)
            runs[replaced] = nil
            waiting[replaced] = nil
            notice.id = replaced
            notices[index] = notice
        } else {
            if let index = notices.firstIndex(where: { $0.id == notice.id }) {
                stopClock(notice.id)
                notices.remove(at: index)
            }
            notices.append(notice)
        }
        runs[notice.id] = Run(remaining: seconds(for: notice))
        startClock(notice.id)
        if announces { GenAnnounce.post(notice.text, priority: notice.tone == .error ? .high : .medium) }
        return notice.id
    }

    /// Takes the notice away now (its close button, or the code that knows it no longer applies).
    public func dismiss(_ id: StackedNotice.ID) {
        stopClock(id)
        runs[id] = nil
        waiting[id] = nil
        notices.removeAll { $0.id == id }
    }

    public func dismissAll() {
        for id in notices.map(\.id) { dismiss(id) }
    }

    /// A press on one of a notice's buttons: the notice goes, stays, or waits, as the action says, then it runs.
    public func press(_ action: StackedNotice.Action, of id: StackedNotice.ID) {
        guard contains(id) else { return }
        switch action.afterPress {
        case .dismiss:
            dismiss(id)
        case .keep:
            break
        case .wait(let words):
            stopClock(id)
            waiting[id] = words
        }
        action.perform(id)
    }

    /// Stops (true) or restarts (false) every notice's clock; a restarted notice has the time it had left.
    public func setPaused(_ paused: Bool) {
        guard paused != isPaused else { return }
        isPaused = paused
        for id in notices.map(\.id) {
            if paused { stopClock(id) } else { startClock(id) }
        }
    }

    /// Seconds a notice has left, nil when it stays until it is closed. For tests and the stack's own view.
    public func remaining(_ id: StackedNotice.ID) -> TimeInterval? {
        guard let run = runs[id], let remaining = run.remaining else { return nil }
        guard let startedAt = run.startedAt else { return remaining }
        return max(0, remaining - (clock.now - startedAt))
    }

    // MARK: Clocks

    private func seconds(for notice: StackedNotice) -> TimeInterval? {
        switch notice.lasting {
        case .untilDismissed:
            return nil
        case .seconds(let seconds):
            return seconds
        case .automatic:
            guard notice.tone != .error else { return nil }
            let timing = timing()
            return notice.actions.isEmpty ? timing.plainSeconds : timing.actionSeconds
        }
    }

    private func startClock(_ id: StackedNotice.ID) {
        guard !isPaused, waiting[id] == nil, var run = runs[id], let remaining = run.remaining, run.startedAt == nil else { return }
        run.startedAt = clock.now
        run.timer = clock.schedule(after: remaining) { [weak self] in self?.expire(id) }
        runs[id] = run
    }

    private func stopClock(_ id: StackedNotice.ID) {
        guard var run = runs[id] else { return }
        run.timer?.cancel()
        run.timer = nil
        if let startedAt = run.startedAt, let remaining = run.remaining {
            run.remaining = max(0, remaining - (clock.now - startedAt))
        }
        run.startedAt = nil
        runs[id] = run
    }

    private func expire(_ id: StackedNotice.ID) {
        guard !isPaused, waiting[id] == nil else { return }
        dismiss(id)
    }
}

// MARK: - Views

/// The stack: the newest notice on top, so a notice that arrives never moves the ones below it, and the oldest sit
/// at the edge the stack grows from. Taller than `maxHeight`, it scrolls.
public struct NoticeStackView: View {
    let model: NoticeStackModel
    var maxWidth: CGFloat
    var maxHeight: CGFloat
    @GenReduceMotion private var reduceMotion
    @State private var contentHeight: CGFloat = 0

    public init(_ model: NoticeStackModel, maxWidth: CGFloat = 520, maxHeight: CGFloat = 360) {
        self.model = model
        self.maxWidth = maxWidth
        self.maxHeight = maxHeight
    }

    public var body: some View {
        let notices = model.notices
        if !notices.isEmpty {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(notices.reversed()) { notice in
                        pill(notice)
                            .transition(.asymmetric(
                                insertion: .opacity.combined(with: .offset(y: 6)),
                                removal: .opacity.animation(.easeOut(duration: GenMotion.removalFadeDuration))))
                    }
                }
                .padding(8)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height.rounded() }) { contentHeight = $0 }
            }
            .scrollDisabled(contentHeight <= maxHeight)
            .scrollIndicators(contentHeight > maxHeight ? .automatic : .never)
            .frame(maxWidth: maxWidth)
            .frame(height: min(contentHeight, maxHeight))
            .onHover { model.setPaused($0) }
            .onDisappear { model.setPaused(false) }
            .animation(GenMotion.animation(expanding: true, reduceMotion: reduceMotion), value: notices.map(\.id))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Notices")
            .accessibilityIdentifier("notice-stack")
        }
    }

    private func pill(_ notice: StackedNotice) -> some View {
        let waiting = model.waiting[notice.id]
        return NoticePill(
            text: notice.text, detail: waiting ?? notice.detail, more: notice.more, tone: notice.tone,
            fixes: waiting != nil ? [] : notice.actions.map { action in
                NoticeFix.button(action.label, symbol: action.symbol, confirm: action.confirm) { model.press(action, of: notice.id) }
            },
            dismiss: { model.dismiss(notice.id) })
            .environment(\.noticePillPlacement, .stacked)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .shadow(color: .black.opacity(0.25), radius: 8, y: 2)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("notice-stack-item")
    }
}

/// A view that holds notice stacks drawn over its visible bounds (a scrolling page), and whether one is around.
private struct NoticeStackViewportKey: EnvironmentKey {
    static let defaultValue = false
}

private struct NoticeStackHostKey: PreferenceKey {
    struct Entry: Equatable {
        let model: NoticeStackModel
        static func == (a: Entry, b: Entry) -> Bool { a.model === b.model }
    }

    static let defaultValue: [Entry] = []

    static func reduce(value: inout [Entry], nextValue: () -> [Entry]) {
        value.append(contentsOf: nextValue())
    }
}

extension EnvironmentValues {
    var noticeStackViewport: Bool {
        get { self[NoticeStackViewportKey.self] }
        set { self[NoticeStackViewportKey.self] = newValue }
    }
}

private struct NoticeStackModifier: ViewModifier {
    let model: NoticeStackModel
    let alignment: Alignment
    @Environment(\.noticeStackViewport) private var viewport

    func body(content: Content) -> some View {
        if viewport {
            content.preference(key: NoticeStackHostKey.self, value: [.init(model: model)])
        } else {
            content.overlay(alignment: alignment) {
                NoticeStackView(model).padding(8)
            }
        }
    }
}

public extension View {
    /// Floats `model`'s notices over this view, at `alignment`. Inside a `noticeStackViewport()` (a page in a scroll
    /// view) they float over that viewport instead, so a notice is on screen wherever the page is scrolled.
    func noticeStack(_ model: NoticeStackModel, alignment: Alignment = .bottom) -> some View {
        modifier(NoticeStackModifier(model: model, alignment: alignment))
    }

    /// Draws the notice stacks of the views inside over this view's bounds, at `alignment`. Put it on the view that
    /// holds a scroll view, so a stack on the scrolled content stays on screen.
    func noticeStackViewport(alignment: Alignment = .bottom) -> some View {
        environment(\.noticeStackViewport, true)
            .overlayPreferenceValue(NoticeStackHostKey.self, alignment: alignment) { entries in
                VStack(spacing: 0) {
                    ForEach(entries.indices, id: \.self) { index in
                        NoticeStackView(entries[index].model)
                    }
                }
                .padding(8)
            }
    }
}
