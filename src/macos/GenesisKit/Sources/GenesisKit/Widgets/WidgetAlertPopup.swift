import Foundation

/// What the alert popup reads from the widget it shows in. `WidgetModel` is the host; the popup's tests use a fake.
/// The popup never writes any of it: each event returns a `WidgetAlertPopup.Effect`, and the host applies it at one
/// place (`WidgetModel.applyAlertPopup`).
@MainActor
protocol WidgetAlertPopupHost: AnyObject {
    /// The surface whose preview is open. While the popup shows, that is the popup's surface.
    var hoveredSurface: WidgetSurfaceID? { get }
    var expanded: EdgePanelPlacement? { get }
    var stopping: Bool { get }
    var dialogOpen: Bool { get }
    var dragging: Bool { get }
    /// Surfaces the pointer is in now, without the hover delay.
    var pointerInside: Set<String> { get }
    var moduleSelections: [String: String] { get }
    var inbox: WidgetInboxSummary { get }
    /// Counts the inbox snapshots, so an alert is settled only by a snapshot newer than its arrival.
    var inboxGeneration: Int { get }
    var inboxOverviewItems: [WidgetInboxItem] { get }
    var sendingDecisionIDs: Set<String> { get }
    var stagedForLeave: [WidgetInboxItem] { get }
    var stagedItems: [WidgetInboxItem] { get }
    var preferences: WidgetPreferences { get }
    /// Applies what one of the popup's timers decided: its countdown ended, or its outcome was shown long enough.
    func applyAlertPopup(_ effect: WidgetAlertPopup.Effect)
}

/// The alert popup: an inbox item the widget pops up by itself in the agents preview, the alerts that wait behind it,
/// how long each one stays, and what a send from it did. It takes the widget's events (alerts arrived, the inbox
/// changed, the pointer entered or left, a module opened, a send ended, stop, reset) and answers each one with an
/// `Effect`: the preview and the modules the widget shows for it. It never writes the hover state or the module
/// selections, so a popup bug and a hover bug no longer share state. The clock is injected, so a test runs its timers
/// without waiting.
@MainActor
public final class WidgetAlertPopup: ObservableObject {
    /// What an event asks of the widget. The host applies it in this order: modules, preview, the hover timer, the
    /// layout, then the staged decisions.
    struct Effect: Equatable {
        enum Preview: Equatable {
            /// Open `surface`'s preview for the popup.
            case show(WidgetSurfaceID)
            /// Close the open preview.
            case hide
        }

        /// `surface` shows module `id` (nil: no module chosen).
        struct Module: Equatable {
            let surface: WidgetSurfaceID
            let id: String?
        }

        enum Staged: Equatable {
            /// "Closing with staged decisions" is "send": send these.
            case send([WidgetInboxItem])
            /// It is "keep": the popup closed, and the staged reminder lists what is staged.
            case remind
        }

        var preview: Preview?
        var modules: [Module] = []
        /// A pending hover open or close would undo the popup's own preview change.
        var cancelHover = false
        /// The panel's presentation changed (`WidgetModel.presentationChanged`).
        var relayout = false
        var staged: Staged?

        mutating func merge(_ other: Effect) {
            preview = other.preview ?? preview
            modules += other.modules
            cancelHover = cancelHover || other.cancelHover
            relayout = relayout || other.relayout
            staged = other.staged ?? staged
        }
    }

    /// The alert shown. The agents preview shows it until its time ends, or until the pointer leaves the panel when
    /// the user moved onto it.
    @Published public private(set) var item: WidgetInboxItem? {
        didSet {
            // An outcome belongs to the alert it was sent from; the next alert starts without one.
            if item?.id != oldValue?.id, outcome != nil { outcome = nil }
        }
    }
    /// What a send from the popup did (its Send now, or Send now in the staged reminder), shown in the popup itself:
    /// the popup stays for `sendCloseSeconds` with it before it moves on, so the result is read where it was sent
    /// (ux audit F5). Nil while nothing was sent from the popup on screen.
    @Published public internal(set) var outcome: WidgetPeekOutcome?
    /// Alerts that arrived while the popup was open, oldest first (Alerts → Several at once: listed or one after
    /// another). The newest-replaces mode keeps it empty.
    @Published public private(set) var queue: [WidgetInboxItem] = []
    /// How the open popup takes another alert, and how long it stays while the pointer is not on it (0: until closed).
    public private(set) var many: WidgetAlerts.PopupMany = .newest
    private(set) var seconds: Double = 7
    /// Duration and the inbox generation when each displayed or waiting alert arrived, by item id. One entry per
    /// alert, so a queue edit that drops an alert drops both.
    private struct Timing {
        var seconds: Double
        var inboxGeneration: Int
    }
    private var timings: [String: Timing] = [:]
    private var outcomeInboxGeneration = 0
    private var task: Task<Void, Never>?
    /// The module the popup replaced on its surface (`previous`, nil when none was chosen) and the one it showed. The
    /// end of the popup puts `previous` back, unless the selection is no longer `shown`: the user picked a module.
    private var replaced: (surface: WidgetSurfaceID, previous: String?, shown: String)?
    private let clock: any Clock<Duration>
    weak var host: (any WidgetAlertPopupHost)?

    init(clock: any Clock<Duration> = ContinuousClock()) {
        self.clock = clock
    }

    /// Whether `alertArrived` would pop an item up in `surface` now: never while the user is in a panel, a window or a
    /// drag, with the pointer on a panel, or in another surface's open preview.
    func canShow(on surface: WidgetSurfaceID) -> Bool {
        guard let host else { return false }
        return !host.stopping && host.expanded == nil && !host.dialogOpen && !host.dragging && host.pointerInside.isEmpty
            && (host.hoveredSurface == nil || host.hoveredSurface == surface)
    }

    /// Pops `new` up in `surface`'s preview for `seconds` (0: until it is closed), unless the user is in a panel, a
    /// window or a drag. With `module`, the surface shows that module for the popup and gets the user's own module back
    /// when it ends. While a popup is open, `many` decides: the new item is listed under it or queued after it (even
    /// with the pointer on the popup, since nothing moves under it), or it replaces the shown one.
    func alertArrived(_ new: WidgetInboxItem, on surface: WidgetSurfaceID, module: String? = nil, seconds: Double = 7,
                      many: WidgetAlerts.PopupMany = .newest) -> Effect {
        guard let host else { return Effect() }
        let generation = host.inboxGeneration
        // The same decision again (answered elsewhere while its alert is shown or waits): it takes that place.
        if let shown = item, let peeked = host.hoveredSurface {
            if shown.sourceId == new.sourceId {
                // A snapshot may report this decision answered while its send outcome is still being shown.
                // Keep the outcome and its timer; `inboxChanged` removes any independently settled resend controls.
                if outcome != nil { return Effect() }
                item = new
                self.seconds = seconds
                timings[new.id] = Timing(seconds: seconds, inboxGeneration: generation)
                PerfLog.mark("widget.peek replaced id=\(new.id) answered=\(new.isAnsweredElsewhere)")
                schedule(on: peeked)
                return Effect(relayout: true)
            }
            if let index = queue.firstIndex(where: { $0.sourceId == new.sourceId }) {
                timings[queue[index].id] = nil
                queue[index] = new
                timings[new.id] = Timing(seconds: seconds, inboxGeneration: generation)
                return Effect(relayout: true)
            }
        }
        if let shown = item, many != .newest, let peeked = host.hoveredSurface {
            if shown.id != new.id, !queue.contains(where: { $0.id == new.id }) {
                queue.append(new)
                timings[new.id] = Timing(seconds: seconds, inboxGeneration: generation)
            }
            self.many = many
            PerfLog.mark("widget.peek added id=\(new.id) mode=\(many.rawValue) waiting=\(queue.count)")
            // A new row gives the list its full time again; a queue keeps the shown alert's own countdown.
            if many == .list, outcome == nil { schedule(on: peeked) }
            return Effect(relayout: true)
        }
        guard canShow(on: surface) else { return Effect() }
        var effect = Effect(preview: .show(surface), cancelHover: true, relayout: true)
        if let module, host.moduleSelections[surface.key] != module {
            if let earlier = replaced, earlier.surface != surface, let restore = restoreModule() {
                effect.modules.append(restore)
            }
            // A second alert during a popup keeps the module from before the first one.
            replaced = replaced ?? (surface, host.moduleSelections[surface.key], module)
            effect.modules.append(Effect.Module(surface: surface, id: module))
        }
        item = new
        queue = []
        timings = [new.id: Timing(seconds: seconds, inboxGeneration: generation)]
        self.many = many
        self.seconds = seconds
        schedule(on: surface)
        return effect
    }

    /// The popup's decisions take the staged pick and note of `staged` (every staged decision of the snapshot). The
    /// popup holds the item it opened with, so without this a pick staged in it showed only until the snapshot listed
    /// it, then read as unanswered (Martin, 2026-10-27: "it shown as staged for a second ... then it just reset").
    func stagingChanged(_ staged: [WidgetInboxItem]) {
        guard item != nil else { return }
        let byId = Dictionary(staged.map { ($0.sourceId, $0) }, uniquingKeysWith: { first, _ in first })
        func fresh(_ item: WidgetInboxItem) -> WidgetInboxItem {
            guard item.kind == "decision", item.needsAnswer else { return item }
            var copy = item
            copy.draftOption = byId[item.sourceId]?.draftOption
            copy.draft = byId[item.sourceId]?.draft
            return copy
        }
        if let shown = item {
            let next = fresh(shown)
            if next != shown { item = next }
        }
        let refreshed = queue.map(fresh)
        if refreshed != queue { queue = refreshed }
    }

    /// The pointer entered or left `surface`. Leaving the popup starts its countdown again, since "Preview stays"
    /// counts the time the pointer is off it; it closed after 220 ms before, 2.5 s after it appeared (Martin,
    /// 2026-10-26: "expands the widget for a few seconds then it disappears"). Nil: the popup does not take the move,
    /// and the hover handles it.
    func pointer(_ surface: WidgetSurfaceID, inside: Bool) -> Effect? {
        guard !inside, item != nil, host?.hoveredSurface == surface else { return nil }
        // An outcome on screen keeps its own lifetime (`sendEnded`).
        if outcome != nil { return Effect() }
        schedule(on: surface)
        return Effect(cancelHover: true)
    }

    /// A row of the popup's list of later alerts: that alert takes the popup, and the one shown takes its row.
    func showWaiting(_ chosen: WidgetInboxItem) -> Effect {
        guard let shown = item, let index = queue.firstIndex(where: { $0.id == chosen.id }) else { return Effect() }
        let waiting = queue[index]
        if settled(waiting) {
            queue.remove(at: index)
            timings[waiting.id] = nil
            return Effect(relayout: true)
        }
        queue[index] = shown
        item = waiting
        seconds = timings[waiting.id]?.seconds ?? 7
        if let surface = host?.hoveredSurface { schedule(on: surface) }
        PerfLog.mark("widget.peek swapped id=\(waiting.id) for=\(shown.id)")
        return Effect(relayout: true)
    }

    /// Decisions `ids` were sent: they leave the popup, which shows the next alert or closes. The popup holds the
    /// decision it opened with, and a decision answered here is in no later snapshot list, so it read as unanswered
    /// after a successful send (Martin, 2026-10-27: "i confirmed it after staging and it doesnt seem like").
    func sent(_ ids: Set<String>) -> Effect {
        let rest = queue.filter { !ids.contains($0.sourceId) }
        if rest != queue { queue = rest }
        guard let shown = item, ids.contains(shown.sourceId) else { return Effect() }
        PerfLog.mark("widget.peek sent id=\(shown.id) waiting=\(queue.count)")
        return end(includeListed: true)
    }

    /// A snapshot must not close the popup before its in-flight send can show its result.
    func keepsSettled(_ alert: WidgetInboxItem) -> Bool {
        outcome != nil || (host?.sendingDecisionIDs.contains(alert.sourceId) ?? false)
    }

    /// A send started from the popup ended: the popup shows `result` instead of closing at once. `ids` are the
    /// decisions sent. Delivered, it stays `sendCloseSeconds` (0: until closed), then moves on as a sent decision does
    /// (`sent`), and the staged reminder closes once nothing is staged any more. Not delivered or failed, it stays
    /// until closed, with Send again for the answers no receiver took.
    func sendEnded(_ result: WidgetPeekOutcome, sent ids: Set<String>, delivered: Bool) -> Effect {
        guard let host, let shown = item,
              ids.contains(shown.sourceId) || shown.sourceId == WidgetAlerts.stagedReminderID else {
            return delivered ? sent(ids) : Effect()
        }
        outcome = result
        outcomeInboxGeneration = host.inboxGeneration
        // The popup's own countdown would end it under the result.
        task?.cancel()
        task = nil
        PerfLog.mark("widget.peek outcome id=\(shown.id) tone=\(result.tone.rawValue) delivered=\(delivered)")
        let seconds = host.preferences.sendCloseSeconds
        guard delivered, seconds > 0 else { return Effect() }
        let clock = self.clock
        task = Task { [weak self] in
            do { try await clock.sleep(for: .seconds(seconds)) } catch { return }
            guard let self, let host = self.host, self.item?.id == shown.id else { return }
            if shown.sourceId == WidgetAlerts.stagedReminderID {
                if host.stagedItems.allSatisfy({ ids.contains($0.sourceId) }) {
                    host.applyAlertPopup(self.end(advance: false))
                } else {
                    self.outcome = nil
                }
            } else {
                host.applyAlertPopup(self.sent(ids))
            }
        }
        return Effect()
    }

    /// The popup's close button, Esc and VoiceOver's escape: the popup ends without opening anything. In the
    /// one-after-another mode it shows the next alert instead, unless `all`; a click elsewhere closes all of them.
    func dismiss(all: Bool = false) -> Effect {
        guard let host, let shown = item else { return Effect() }
        if outcome == nil, let surface = host.hoveredSurface, let held = hold(on: surface) { return held }
        PerfLog.mark("widget.peek dismissed id=\(shown.id) all=\(all)")
        var effect = end(advance: !all)
        effect.cancelHover = true
        // The pointer is on the panel (it pressed ×): without this the hover list would open in the popup's place.
        if item == nil, effect.preview == nil, host.expanded == nil, host.hoveredSurface != nil {
            effect.preview = .hide
            effect.relayout = true
        }
        return effect
    }

    /// Ends the popup, or with `advance` shows the next queued alert (and with `includeListed` the next listed one).
    /// An open panel keeps the popup's module under the user; `reset` gives it back once the panel closes.
    func end(advance: Bool = true, includeListed: Bool = false) -> Effect {
        task?.cancel()
        task = nil
        guard let host, let shown = item else { return Effect() }
        if advance, many == .queue || includeListed, let surface = host.hoveredSurface, let next = nextQueued() {
            timings[shown.id] = nil
            item = next
            seconds = timings[next.id]?.seconds ?? 7
            PerfLog.mark("widget.peek next id=\(next.id) after=\(shown.id) waiting=\(queue.count)")
            schedule(on: surface)
            return Effect(relayout: true)
        }
        item = nil
        queue = []
        timings = [:]
        var effect = Effect(relayout: true)
        if host.expanded == nil, let surface = host.hoveredSurface, !host.pointerInside.contains(surface.key) {
            effect.preview = .hide
        }
        if host.expanded == nil, let restore = restoreModule() { effect.modules.append(restore) }
        PerfLog.mark("widget.peek end id=\(shown.id)")
        return effect
    }

    /// The host's inbox changed (`WidgetModel.updateInbox`): settled alerts leave the list and the queue, a settled
    /// alert on screen gives way, and Send again drops the answers another surface settled.
    func inboxChanged() -> Effect {
        guard let host else { return Effect() }
        var effect = Effect()
        // Remove settled alerts in both list and queue mode. A visible alert must not keep answer buttons either.
        let settledWaiting = queue.filter { settled($0) }
        if !settledWaiting.isEmpty {
            let ids = Set(settledWaiting.map(\.id))
            queue.removeAll { ids.contains($0.id) }
            for id in ids { timings[id] = nil }
            effect.relayout = true
        }
        if let shown = item, settled(shown), !keepsSettled(shown) {
            if many == .list, let next = queue.first {
                effect.merge(showWaiting(next))
                queue.removeAll { $0.id == shown.id }
                timings[shown.id] = nil
                effect.relayout = true
            } else {
                effect.merge(end())
            }
        }
        let inbox = host.inbox
        if let current = outcome, inbox.complete, host.inboxGeneration > outcomeInboxGeneration {
            // Absence from pendingDecisionIDs is not enough: an answered decision can still need delivery.
            // The explicit answered-elsewhere rows identify decisions already settled by another surface.
            let answered = Set((inbox.answeredElsewhere ?? []).filter(\.isAnsweredElsewhere).map(\.sourceId))
            let waiting = current.sendAgain.filter { !answered.contains($0.sourceId) }
            if waiting != current.sendAgain {
                outcome = WidgetPeekOutcome(text: current.text, tone: current.tone, sendAgain: waiting,
                                            detail: current.detail)
            }
        }
        return effect
    }

    /// The user picked a module on `surface` (also by clicking the popup itself): it stays after the popup, which
    /// ends. A pick on another surface gives the surface the popup switched its own module back first.
    func moduleOpened(on surface: WidgetSurfaceID) -> Effect {
        var effect = Effect()
        if replaced?.surface == surface {
            replaced = nil
        } else if let restore = restoreModule() {
            effect.modules.append(restore)
        }
        clear()
        return effect
    }

    /// The panel folded (`WidgetModel.collapse`): the popup ends, and its surface gets the user's module back.
    func reset() -> Effect {
        clear()
        var effect = Effect()
        if let restore = restoreModule() { effect.modules.append(restore) }
        return effect
    }

    /// The widget stops: no timer of the popup fires any more.
    func stop() {
        task?.cancel()
        task = nil
    }

    private func clear() {
        task?.cancel()
        task = nil
        item = nil
        queue = []
        timings = [:]
    }

    /// The popup's time ran out with a decision staged in it: it does not just go away (D159, 2026-10-27: staged in
    /// the popup at 01:08:32, the popup closed 7 s later, and the answer was never sent). "Closing with staged
    /// decisions" decides, as for the panel: "send" sends them and the popup shows the result; "keep" closes it and
    /// shows the staged reminder; "ask" (the default) keeps the popup with its Send now and looks again after its
    /// time. Nil: nothing holds the popup, and it may end.
    private func hold(on surface: WidgetSurfaceID) -> Effect? {
        guard let host, let shown = item else { return nil }
        let inPopup = Set(([shown] + queue).map(\.sourceId))
        // A send from the popup is under way: its result shows here (`sendEnded`).
        if !inPopup.isDisjoint(with: host.sendingDecisionIDs) {
            schedule(on: surface)
            return Effect()
        }
        let staged = host.stagedForLeave.filter { inPopup.contains($0.sourceId) }
        guard !staged.isEmpty else { return nil }
        switch host.preferences.stagedOnLeave {
        case "send":
            PerfLog.mark("widget.peek staged send=\(staged.count) id=\(shown.id)")
            schedule(on: surface)
            return Effect(staged: .send(staged))
        case "keep":
            PerfLog.mark("widget.peek staged remind=\(staged.count) id=\(shown.id)")
            var effect = end(advance: false)
            effect.staged = .remind
            return effect
        default:
            PerfLog.mark("widget.peek staged held=\(staged.count) id=\(shown.id)")
            schedule(on: surface)
            return Effect()
        }
    }

    /// Starts the popup's countdown again. It ends the popup only while the pointer is off it; with 0 seconds the
    /// popup stays until it is closed.
    private func schedule(on surface: WidgetSurfaceID) {
        task?.cancel()
        task = nil
        guard seconds > 0, let shown = item else { return }
        let seconds = self.seconds
        let clock = self.clock
        task = Task { [weak self] in
            do { try await clock.sleep(for: .seconds(seconds)) } catch { return }
            guard let self, let host = self.host, self.item?.id == shown.id,
                  !host.pointerInside.contains(surface.key) else { return }
            host.applyAlertPopup(self.hold(on: surface) ?? self.end())
        }
    }

    /// Only a newer complete snapshot with the uncapped decision list can prove settlement.
    private func settled(_ alert: WidgetInboxItem) -> Bool {
        guard let host, alert.kind == "decision", alert.needsAnswer, host.inbox.complete,
              host.inboxGeneration > (timings[alert.id]?.inboxGeneration ?? host.inboxGeneration),
              let pending = host.inbox.pendingDecisionIDs else { return false }
        return !pending.contains(alert.sourceId)
    }

    /// The next queued alert that still applies: a decision answered in the meantime is skipped.
    private func nextQueued() -> WidgetInboxItem? {
        while !queue.isEmpty {
            let next = queue.removeFirst()
            if settled(next) {
                timings[next.id] = nil
                continue
            }
            guard let fresh = host?.inboxOverviewItems.first(where: { $0.id == next.id }) else { return next }
            if next.kind == "decision", next.needsAnswer { return fresh.needsAnswer ? fresh : next }
            if fresh.needsAnswer || !next.needsAnswer { return fresh }
        }
        return nil
    }

    /// Puts back the module the popup replaced, unless the user chose another one since. Not saved to the defaults:
    /// the popup's own switch never was either.
    private func restoreModule() -> Effect.Module? {
        guard let earlier = replaced else { return nil }
        replaced = nil
        guard host?.moduleSelections[earlier.surface.key] == earlier.shown else { return nil }
        return Effect.Module(surface: earlier.surface, id: earlier.previous)
    }
}

/// What a send started from the alert popup did, for the popup to show before it moves on (`WidgetAlertPopup.outcome`).
public struct WidgetPeekOutcome: Equatable {
    public let text: String
    public let tone: WidgetNoticeTone
    /// Answered decisions no receiver took, for the popup's Send again (`WidgetModel.resendAnswers`).
    public let sendAgain: [WidgetInboxItem]
    /// Hub details (each session's own reason), behind a Details disclosure.
    public let detail: String?

    public init(text: String, tone: WidgetNoticeTone, sendAgain: [WidgetInboxItem] = [], detail: String? = nil) {
        self.text = text
        self.tone = tone
        self.sendAgain = sendAgain
        self.detail = detail
    }
}
