import AppKit
import SwiftUI

// GenesisTools --meetings [--place needs|all|project:<name>] [--meeting <id>] [--tab transcript|screen|items|speakers|context] [--no-focus] [--muted]
//   The Meetings window: meetings by day with what each needs, one meeting with its transcript, screen, items,
//   speakers and context, the meetings that need you, and each project. One per login session: a later launch hands
//   its request to the running one and exits. `--muted` starts a window whose Moments play without sound (a check
//   of the running window on a Mac that must stay quiet).
// GenesisTools --meetings … --snapshot <png> [--width <pt>] [--height <pt>] [--play <target json>] [--place contacts]
//                         [--side-panel] [--select <row id>] [--edit <row id>] [--notice <text>]
//   Draws the window off screen into a PNG once its data has loaded, then exits (verification without a screen).
//   `--select` selects a review row of the Items tab (its number keys show) and `--edit` opens its editor, so a
//   picture can show the states that a click or a key makes. `--notice <text>` floats a notice with an Undo over the
//   meeting, as an answer or a Skip leaves one.
//   `--sheet room-devices` opens People with Room devices expanded. `--device-offers-file` takes an array of offers
//   (keeping the store's confirmed devices) or a complete people.devices.list result for a seats or Contacts picture.
//   `--card <row id>` draws that row's pin card alone, and `--sheet history` (or `history:<row id>`) the history
//   sheet alone: a popover and a sheet are windows of their own, which the window's picture does not hold.
//   `--sheet seats` draws the seats sheet, and `--sheet selection:<from>-<to>` the transcript's selection popover for
//   those line indexes, then redraws it ten times with each redraw's main-thread time in app-perf.log.
//   `--undo-person <name>` removes that person from the meeting, presses Undo on the notice, and pictures the notice
//   once the undo has answered (at most 10 s): it writes to the record, so use it on a copy.
//   `--play '{"kind":"item","id":"i2"}'` (a Moment target as the engine writes it) starts that Moment of the meeting
//   without sound first, so the picture shows the dock, the timeline and the playing row.

private let meetingsInstance = SingleInstance(
    name: "meetings",
    lockFile: NativePreview.hubFile("meetings.lock"),
    notificationPrefix: meetingsNotificationPrefix(),
    retryHint: "close the Meetings window, then try again.",
    log: { HubPerf.log($0) }
)

/// The names of the forwarded request and its answer. They are distributed notifications, which every process of the
/// login session sees, while the lock is per home: a window started on a sandbox (`GENESIS_TOOLS_HOME`) followed every
/// `tools meetings window` request meant for the real window. A sandbox home carries its path in the name; the real
/// home keeps the old name, so a window from an older build still takes the request.
func meetingsNotificationPrefix(home: String = GenesisToolsHome.home(), realHome: String = NSHomeDirectory()) -> String {
    let base = NativePreview.namespace + ".meetings"
    let canonical = canonicalHome(home)
    return canonical == canonicalHome(realHome) ? base : base + ".home:" + canonical
}

/// A home as one spelling: a trailing slash, `.` and `..` parts and symlinks (`/tmp` is `/private/tmp`) name the same
/// folder, so they give the same notification name and a later launch reaches the window that holds the lock.
func canonicalHome(_ path: String) -> String {
    URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
}

struct MeetingsRequest {
    var place: MeetingsWindowModel.Place?
    var meeting: String?
    var tab: MeetingDetailModel.Tab?
    var focus = true
    var newWindow = false
    /// `--muted`: the window's Moments play without sound.
    var muted = false
    /// `--side-panel`: the settings side panel opens beside the meeting.
    var sidePanel = false
    var snapshot: String?
    /// `--play <target json>`: the Moment a snapshot starts, silently, before the picture.
    var play: MomentTarget?
    /// A routed Moment with all per-call playback options preserved.
    var playRequest: MeetingsAPI.MomentParams?
    /// `--show <from>,<to>`: a snapshot of what a "Show" chip does: the whole meeting plays from `from`, silently, and
    /// the timeline shows the range.
    var show: ClosedRange<Double>?
    /// `--zoom-to <from>,<to>` (repeatable): a snapshot's zoom levels, as clicks on merged pins add them.
    var zoomTo: [ClosedRange<Double>] = []
    /// `--select <row id>` and `--edit <row id>`: a snapshot's selected review row, and the row whose editor is open.
    var select: String?
    var edit: String?
    /// `--notice <text>`: a notice with an Undo, as an answer leaves one.
    var notice: String?
    /// `--card <row id>` and `--sheet history[:<row id>]` or `--sheet voice-tools[:details]`, `--sheet word-timings`, `--sheet link-source` or `--sheet person:<name>`
    /// (`person:` alone adds one): a snapshot of that part alone.
    var card: String?
    var sheet: String?
    /// `--suggest-progress <fraction>,<label>`: a snapshot of the Items tab while a suggest run reports that step (the
    /// fraction `-` for none). No run starts; the picture shows the state the service's `$/progress` makes.
    var suggestProgress: MeetingsCallProgress?
    /// `--voices open|preview`: a snapshot with the Voices pane open; `preview` runs the voice preview first (a real
    /// `voices.preview`, nothing saved). `--voices-progress <fraction>,<label>`: the pane while a preview reports that
    /// step (no run starts).
    var voices: String?
    var voicesProgress: MeetingsCallProgress?
    /// Open one person's sample disclosure, or replay captured voices.jobs JSON in an offscreen picture.
    var voiceFocus: String?
    var voiceSample: String?
    var voiceJobFile: String?
    var deviceOffersFile: String?
    /// `--undo-person <name>`: a removal of that person and its notice's Undo, before the picture.
    var undoPerson: String?
    var width: CGFloat = 1280
    var height: CGFloat = 820

    static func parse(_ args: [String]) -> MeetingsRequest {
        var request = MeetingsRequest()
        var index = 0
        func value() -> String? {
            guard index + 1 < args.count else { return nil }
            index += 1
            return args[index]
        }
        while index < args.count {
            switch args[index] {
            case "--place":
                switch value() ?? "" {
                case "needs": request.place = .needs
                case "all": request.place = .all
                case "contacts": request.place = .contacts
                case let other where other.hasPrefix("project:"): request.place = .project(String(other.dropFirst(8)))
                case let other where other.hasPrefix("voices:"): request.place = .projectVoices(String(other.dropFirst(7)))
                default: break
                }
            case "--meeting": request.meeting = value()
            case "--new-window": request.newWindow = true
            case "--tab": request.tab = value().flatMap(MeetingDetailModel.Tab.init(rawValue:))
            case "--no-focus", "--no-activate": request.focus = false
            case "--muted": request.muted = true
            case "--side-panel": request.sidePanel = true
            case "--select": request.select = value()
            case "--edit": request.edit = value()
            case "--notice": request.notice = value()
            case "--card": request.card = value()
            case "--sheet": request.sheet = value()
            case "--suggest-progress": request.suggestProgress = value().map(MeetingsRequest.progress)
            case "--voices": request.voices = value()
            case "--voice-focus": request.voiceFocus = value()
            case "--voice-sample": request.voiceSample = value()
            case "--voice-job-file": request.voiceJobFile = value()
            case "--device-offers-file": request.deviceOffersFile = value()
            case "--voices-progress": request.voicesProgress = value().map(MeetingsRequest.progress)
            case "--undo-person": request.undoPerson = value()
            case "--snapshot": request.snapshot = value().map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).path }
            case "--play": request.play = value().flatMap { try? JSONDecoder().decode(MomentTarget.self, from: Data($0.utf8)) }
            case "--play-request": request.playRequest = value().flatMap { try? JSONDecoder().decode(MeetingsAPI.MomentParams.self, from: Data($0.utf8)) }
            case "--show": request.show = value().flatMap(MeetingsRequest.range)
            case "--zoom-to": if let range = value().flatMap(MeetingsRequest.range) { request.zoomTo.append(range) }
            case "--width": request.width = value().flatMap(Double.init).map { CGFloat($0) } ?? request.width
            case "--height": request.height = value().flatMap(Double.init).map { CGFloat($0) } ?? request.height
            default: break
            }
            index += 1
        }
        if request.snapshot != nil && request.sheet == "room-devices" { request.place = .contacts }
        return request
    }

    /// "0.4,Voices: 120 of 300 lines" as a step; "-" or no number is no fraction, nothing after the comma no label.
    static func progress(_ text: String) -> MeetingsCallProgress {
        let parts = text.split(separator: ",", maxSplits: 1, omittingEmptySubsequences: false)
        let label = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces) : ""
        return MeetingsCallProgress(fraction: parts.first.flatMap { Double($0) }, label: label.isEmpty ? nil : label)
    }

    /// "2926,5220" as seconds; nil for anything else.
    static func range(_ text: String) -> ClosedRange<Double>? {
        let parts = text.split(separator: ",").compactMap { Double($0) }
        guard parts.count == 2, parts[1] > parts[0] else { return nil }
        return parts[0]...parts[1]
    }
}

package func runMeetings(_ args: [String]) -> Never {
    let request = MeetingsRequest.parse(args)
    if let snapshot = request.snapshot {
        runMeetingsSnapshot(request, to: snapshot)
    }
    if !meetingsInstance.claim() {
        exit(meetingsInstance.forward(args) ? 0 : 1)
    }
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        MeetingsMenuTarget.shared.model = MeetingsWindow.shared.model
        MeetingsMenu.install()
        HangWatch.start()
        meetingsInstance.serve { forwarded in
            let next = MeetingsRequest.parse(forwarded)
            MainActor.assumeIsolated {
                if next.newWindow { MeetingsWindow.openExtra(request: next) }
                else { MeetingsWindow.shared.show(next) }
            }
        }
        MeetingsWindow.shared.show(request)
        app.run()
    }
    exit(0)
}

@MainActor
final class MeetingsWindow: NSObject, NSWindowDelegate {
    static let shared = MeetingsWindow(primary: true)
    /// The windows "Open in New Window" made: each has its own model, so two meetings show side by side.
    private static var extras: [MeetingsWindow] = []
    /// The first window keeps the saved frame and answers forwarded requests; an extra one cascades from the key window.
    let primary: Bool
    private var window: NSWindow?
    private var startFailureListening: MeetingsService.Listening?
    let model = MeetingsWindowModel()

    init(primary: Bool) {
        self.primary = primary
    }

    /// Opens `meeting` in a new window of its own, offset from the key window, so the reader can put the two side by side.
    static func openExtra(meeting: String) {
        var request = MeetingsRequest()
        request.meeting = meeting
        openExtra(request: request)
    }

    static func openExtra(request: MeetingsRequest) {
        let face = MeetingsWindow(primary: false)
        extras.append(face)
        let source = NSApp.keyWindow
        face.show(request)
        if let source, let window = face.window {
            window.setFrame(source.frame, display: false)
            window.setFrameTopLeftPoint(window.cascadeTopLeft(from: NSPoint(x: source.frame.minX, y: source.frame.maxY)))
        }
    }

    func show(_ request: MeetingsRequest) {
        let window = window ?? Self.makeWindow(model: model, size: NSSize(width: request.width, height: request.height))
        if self.window == nil {
            window.delegate = self
            if primary { window.setFrameAutosaveName("GenesisToolsMeetings") }
            self.window = window
            startFailureListening = model.service?.listenForStartFailure { [weak model = model] failure in
                model?.notices.push(.meetingsFailure(failure))
            }
            model.load()
        }
        apply(request, to: model)
        if request.focus {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        } else {
            window.orderBack(nil)
        }
    }

    func apply(_ request: MeetingsRequest, to model: MeetingsWindowModel) {
        if request.muted {
            model.player.stop()
            model.player = MomentPlayer(load: { try AVMomentSound(url: $0, muted: true) }, defaults: model.defaults)
        }
        if let place = request.place { model.go(place) }
        if request.sidePanel { model.sidePanelOpen = true }
        if let meeting = request.meeting {
            model.select(meeting, tab: request.tab)
            model.detail?.restoreRowsForReopen()
        } else if let tab = request.tab {
            model.detail?.show(tab)
        }
        if let play = request.playRequest {
            model.player.play(play, from: .link)
        }
    }

    /// The smallest window the layout is made for (the detail column narrows its header and tabs to fit it).
    static let minimumSize = NSSize(width: 900, height: 560)

    /// The hosting view sets the window's minimum back to zero as it lays out, so `minSize` alone let the window
    /// shrink until the detail column was cut off. The delegate holds the floor on every live resize.
    static func floored(_ size: NSSize) -> NSSize {
        NSSize(width: max(size.width, minimumSize.width), height: max(size.height, minimumSize.height))
    }

    func windowWillResize(_ sender: NSWindow, to frameSize: NSSize) -> NSSize { Self.floored(frameSize) }

    /// A window that holds one part at its own size, for a snapshot of a popover or a sheet.
    static func partWindow(_ part: AnyView) -> NSWindow {
        let hosting = NSHostingView(rootView: part.background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, .dark))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: hosting.fittingSize), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        return window
    }

    static func makeWindow(model: MeetingsWindowModel, size: NSSize, roomDevices: MeetingsAPI.RoomDevices.Result? = nil) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Meetings"
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        let hosting = NSHostingView(rootView: MeetingsRootView(model: model).environment(model).environment(\.roomDevicesPreview, roomDevices))
        // The window keeps the size the reader gives it, and `minimumSize` is its only floor: with the default options,
        // and still with `.minSize`, each notice grew the window to the content's height (900 to 1982 pt in one session).
        hosting.sizingOptions = []
        window.contentView = hosting
        window.minSize = minimumSize
        window.center()
        return window
    }

    func windowDidBecomeKey(_ notification: Notification) {
        // The menu bar and the playback keys act on the window in front.
        MeetingsMenuTarget.shared.model = model
        // A meeting changed elsewhere (a confirm in a terminal, a new recording) shows when the window comes back.
        if case .loaded = model.overview { model.refreshAfterReturn() }
    }

    func windowDidChangeOcclusionState(_ notification: Notification) {
        // A live meeting refreshes only while the window can be seen (MeetingsWindowModel.windowVisible).
        model.windowVisible = (notification.object as? NSWindow)?.occlusionState.contains(.visible) ?? true
    }

    /// ⌘Z and Edit → Undo go to the window's undo manager; with no text field in focus it presses the newest notice's
    /// Undo (G39), and in a field it is the field's own undo.
    private lazy var noticeUndoManager = MeetingsUndoManager(model: model)

    func windowWillReturnUndoManager(_ window: NSWindow) -> UndoManager? {
        noticeUndoManager.window = window
        return noticeUndoManager
    }

    /// The last window closed ends the process, as the hub's window does. An extra window stops its sound and its
    /// listener; the first window stays made, so a forwarded request opens it again.
    func windowWillClose(_ notification: Notification) {
        if !primary {
            model.player.stop()
            model.detail?.cancelReads()
            model.detachLiveUpdates()
            Self.extras.removeAll { $0 === self }
            if MeetingsMenuTarget.shared.model === model { MeetingsMenuTarget.shared.model = Self.shared.model }
        }
        let others = ([Self.shared] + Self.extras).filter { $0 !== self && $0.window?.isVisible == true }
        if others.isEmpty { NSApp.terminate(nil) }
    }
}

/// A part of the window drawn alone for a snapshot (`--card`, `--sheet`), with its data read first.
@MainActor
private func meetingsSnapshotPart(_ request: MeetingsRequest, model: MeetingsWindowModel, offers: [RoomDeviceOffer]?) async -> AnyView? {
    if request.sheet == "voice-library-settings" {
        guard await waitUntil(40, { model.settingsRaw != nil || model.settings.failure != nil }), let raw = model.settingsRaw else { return nil }
        return AnyView(MeetingsVoiceLibraryCard(config: .init(raw: raw), set: { _, _ in })
            .padding(24).frame(maxWidth: 850).frame(width: request.width, height: request.height, alignment: .top)
            .environment(\.nativeSettingsTheme, .graphite))
    }
    if let sheet = request.sheet, sheet.hasPrefix("person-voices:") {
        let query = String(sheet.dropFirst("person-voices:".count))
        do {
            let result = try await PeopleCalls.known(.init(query: query, limit: 500)).run(service: model.service)
            let matches = result.people.filter { $0.email?.caseInsensitiveCompare(query) == .orderedSame ||
                                                 $0.name.caseInsensitiveCompare(query) == .orderedSame }
            guard matches.count == 1, let person = matches.first else {
                FileHandle.standardError.write(Data("meetings snapshot: person-voices requires one exact name or email\n".utf8))
                return nil
            }
            let destination = VoiceDestination.person(.init(name: person.name, email: person.email), project: nil)
            guard await prepareLibrarySnapshot(destination, model: model) else { return nil }
            model.people.showMeetings(person, voices: true)
            guard let history = model.people.history else { return nil }
            return AnyView(PersonMeetingsSheet(history: history, library: model.voiceLibrary, retry: {}, open: { _ in }, close: {})
                .frame(width: request.width, height: request.height))
        } catch {
            FileHandle.standardError.write(Data("meetings snapshot: person lookup failed: \(error)\n".utf8))
            return nil
        }
    }
    guard let detail = model.detail else { return nil }
    if let id = request.card {
        if case .idle = detail.rows { detail.loadRows() }
        _ = await waitUntil(60) { detail.rows.value != nil || detail.rows.failure != nil }
        let rows = detail.rows.value?.rows ?? []
        return rows.first { $0.id == id }.map { row in
            // The window's dock builds the card inside the meeting's view; the picture gives it the same detail.
            AnyView(PinCard(row: row, reference: { id in rows.first { $0.id == id }.map(ReviewRowView.reference) })
                .environment(\.meetingDetail, detail))
        }
    }
    if let sheet = request.sheet, sheet == "history" || sheet.hasPrefix("history:") {
        if case .idle = detail.rows { detail.loadRows() }
        _ = await waitUntil(60) { detail.rows.value != nil || detail.rows.failure != nil }
        detail.openHistory(item: sheet.hasPrefix("history:") ? String(sheet.dropFirst(8)) : nil)
        _ = await waitUntil(30) { detail.history?.entries.value != nil || detail.history?.entries.failure != nil }
        return detail.history.map { AnyView(HistorySheetView(detail: detail, history: $0)) }
    }
    if let sheet = request.sheet, sheet == "voice-tools" || sheet == "voice-tools:details" {
        if case .idle = detail.speakers { detail.loadSpeakers() }
        _ = await waitUntil(60) { detail.speakers.value != nil || detail.speakers.failure != nil }
        return AnyView(MeetingVoiceToolsSheet(detail: detail, evidenceOpen: sheet.hasSuffix(":details"), close: {}))
    }
    if request.sheet == "word-timings" {
        // The pane's "Word timings…" with nothing selected: the range from the line at the start.
        if case .idle = detail.transcript { detail.loadTranscript() }
        _ = await waitUntil(60) { detail.transcript.value != nil || detail.transcript.failure != nil }
        _ = await waitUntil(30) { model.settings.value != nil || model.settings.failure != nil }
        let lines = (detail.transcript.value?.entries ?? []).lazy.map { (start: $0.startSec, end: $0.endSec) }
        typealias Transcript = MeetingsPreferences.Transcript
        let choice = Transcript.timingLanguage.value(model.defaults)
        let code = Transcript.timingLanguageCode(choice, meeting: model.settings.value?.global.language)
        return AnyView(WordTimingOptions(range: .near(lines, position: 0),
                                         model: SidePanelWords.choice(Transcript.timingModel.value(model.defaults).rawValue,
                                                                      key: Transcript.timingModel.key),
                                         language: WordTimingOptions.languageWords(choice, code: code),
                                         openSettings: {}, cancel: {}, generate: {}))
    }
    if request.sheet == "link-source" {
        // The list read first, so the picture shows the meetings, not the read.
        let list: Loadable<MeetingsAPI.MeetingSourcesNear.Result>
        do { list = .loaded(try await detail.sourceMeetingsNear()) } catch { list = .failed(asFailure(error), previous: nil) }
        return AnyView(LinkSourceSheet(detail: detail, list: list, close: {}))
    }
    if request.sheet == "seats" {
        let preview: Loadable<MeetingsAPI.SeatsSuggest.Suggestion>
        do {
            var suggestion = try await detail.suggestedSeats()
            if let offers { suggestion.deviceOffers = offers }
            preview = .loaded(suggestion)
        } catch {
            if offers != nil {
                FileHandle.standardError.write(Data("meetings snapshot: the seats suggestion did not load: \(error)\n".utf8))
                return nil
            }
            preview = .failed(asFailure(error), previous: nil)
        }
        return AnyView(MeetingSeatsEditor(seats: detail.record.value?.seats, preview: preview,
                                          load: { try await detail.suggestedSeats() }, save: { _, _ in }, saved: {})
            .environment(\.meetingDetail, detail))
    }
    if let sheet = request.sheet, sheet.hasPrefix("selection:") {
        let bounds = sheet.dropFirst("selection:".count).split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2, let first = Int(bounds[0]), let last = Int(bounds[1]), first >= 0, first <= last else { return nil }
        if case .idle = detail.transcript { detail.loadTranscript() }
        _ = await waitUntil(60) { detail.transcript.value != nil || detail.transcript.failure != nil }
        if case .idle = detail.rows { detail.loadRows() }
        _ = await waitUntil(60) { detail.rows.value != nil || detail.rows.failure != nil }
        let entries = detail.transcript.value?.entries ?? []
        guard entries.indices.contains(last) else { return nil }
        let projection = TranscriptPaneProjection.make(.init(entries: entries, applyAbove: 70, items: detail.record.value?.items ?? [],
                                                             evidence: detail.rows.value?.lineEvidence ?? [],
                                                             durationSec: model.meeting(detail.id)?.durationSec))
        let range = first...last
        let selection = Set(projection.built.flatMap(\.lines).filter { range.contains($0.index) }.map(\.id))
        FileHandle.standardError.write(Data("meetings snapshot: selection of \(selection.count) of \(entries.count) lines, \(detail.record.value?.items.count ?? 0) items\n".utf8))
        let facts = TranscriptSelectionFacts.make(.init(selection: selection, built: projection.built, shown: projection.shown,
                                                        entries: entries, voice: detail.record.value?.evidence?.voice?.lines ?? [:],
                                                        evidence: detail.rows.value?.lineEvidence ?? [], items: detail.record.value?.items ?? [],
                                                        ruleNames: model.ruleNames ?? [:]))
        return facts.map { AnyView(TranscriptSelectionPopover(detail: detail, facts: $0, clipSec: 5, clear: {})) }
    }
    if let sheet = request.sheet, sheet.hasPrefix("person:") {
        let name = String(sheet.dropFirst(7))
        return AnyView(PersonStayEditor(detail: detail, original: name.isEmpty ? nil : PersonStay.of(name, in: detail.record.value),
                                        duration: model.meeting(detail.id)?.durationSec, close: {}))
    }
    return nil
}

/// Waits (up to `seconds`) until `ready` holds, checking every 100 ms; a snapshot needs the data on screen.
@MainActor
func waitUntil(_ seconds: Double, _ ready: () -> Bool) async -> Bool {
    var waited = 0.0
    while !ready(), waited < seconds {
        try? await Task.sleep(for: .milliseconds(100))
        waited += 0.1
    }
    return ready()
}

@MainActor
private func prepareLibrarySnapshot(_ destination: VoiceDestination, model: MeetingsWindowModel) async -> Bool {
    let library = model.voiceLibrary
    library.show(destination, doubtfulFirst: model.defaults.object(forKey: MeetingsVoiceCompute.doubtfulFirstKey) as? Bool ?? true)
    guard await waitUntil(60, { library.rows.value != nil || library.rows.failure != nil }), library.rows.value != nil else {
        FileHandle.standardError.write(Data("meetings snapshot: \(library.rows.failure?.sentence ?? "voice library read timed out")\n".utf8))
        return false
    }
    if let sample = model.voiceSampleFocus, library.rows.value?.location(of: sample) == nil {
        FileHandle.standardError.write(Data("meetings snapshot: the selected sample is absent from this scope\n".utf8))
        return false
    }
    if library.snapshotJobs != nil && library.jobs.isEmpty {
        FileHandle.standardError.write(Data("meetings snapshot: the captured jobs do not belong to this destination\n".utf8))
        return false
    }
    return true
}

private func runMeetingsSnapshot(_ request: MeetingsRequest, to path: String) -> Never {
    MainActor.assumeIsolated {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        Task {
            let model = MeetingsWindowModel()
            // A picture with the panel open must not change what the real window opens with.
            model.remembersPanel = false
            model.voiceFocus = request.voiceFocus
            model.voiceSampleFocus = request.voiceSample
            var offers: [RoomDeviceOffer]?
            var roomDevices: MeetingsAPI.RoomDevices.Result?
            if let file = request.deviceOffersFile {
                do {
                    let bytes = try Data(contentsOf: URL(fileURLWithPath: file))
                    let decoder = JSONDecoder()
                    if let list = try? decoder.decode(MeetingsAPI.RoomDevices.Result.self, from: bytes) {
                        roomDevices = list
                        offers = list.offers
                    } else {
                        offers = try decoder.decode([RoomDeviceOffer].self, from: bytes)
                    }
                } catch {
                    FileHandle.standardError.write(Data("meetings snapshot: could not read device offers from \(file): \(error)\n".utf8))
                    exit(1)
                }
            }
            if let file = request.voiceJobFile {
                do {
                    model.voiceLibrary.snapshotJobs = try JSONDecoder().decode([VoiceJob].self, from: Data(contentsOf: URL(fileURLWithPath: file)))
                } catch {
                    FileHandle.standardError.write(Data("meetings snapshot: could not read the captured jobs: \(error)\n".utf8))
                    exit(1)
                }
            }
            model.sidePanelOpen = request.sidePanel
            // A picture of a playing Moment (`--play`) makes no sound.
            model.player = MomentPlayer(load: { try AVMomentSound(url: $0, muted: true) }, defaults: model.defaults)
            // The requested meeting is the selection before the list lands, so the list's first meeting is never read
            // for nothing; the request applies once the list is there, so a recording-only meeting opens on Screen.
            model.selectedMeetingID = request.meeting
            model.load()
            guard await waitUntil(40, { model.overview.value != nil || model.overview.failure != nil }) else {
                FileHandle.standardError.write(Data("meetings snapshot timed out loading overview\n".utf8))
                exit(1)
            }
            MeetingsWindow.shared.apply(request, to: model)
            if let detail = model.detail {
                let ready = await waitUntil(60) {
                    let tabReady: Bool
                    switch detail.tab {
                    case .transcript: tabReady = detail.transcript.value != nil || detail.transcript.failure != nil
                    case .screen: tabReady = detail.timeline.value != nil || detail.timeline.failure != nil
                    case .speakers: tabReady = detail.speakers.value != nil || detail.speakers.failure != nil
                    case .items, .context: tabReady = true
                    }
                    return tabReady && (detail.record.value != nil || detail.record.failure != nil)
                }
                guard ready else {
                    FileHandle.standardError.write(Data("meetings snapshot timed out loading detail \(detail.tab)\n".utf8))
                    exit(1)
                }
            }
            if model.place == .contacts {
                _ = await waitUntil(30) { model.people.known.value != nil || model.people.known.failure != nil }
                if request.sheet == "room-devices" || offers != nil {
                    guard model.people.known.value != nil else {
                        FileHandle.standardError.write(Data("meetings snapshot: the people book did not load\n".utf8))
                        exit(1)
                    }
                    if roomDevices == nil {
                        do {
                            var list = try await PeopleCalls.roomDevices(offers: offers == nil, service: model.service)
                            if let offers { list.offers = offers }
                            roomDevices = list
                        } catch {
                            FileHandle.standardError.write(Data("meetings snapshot: the room devices did not load: \(error)\n".utf8))
                            exit(1)
                        }
                    }
                }
            }
            if let detail = model.detail, detail.tab == .items {
                // The rows are read when the tab shows; a picture taken before they land shows "Reading the items…".
                if case .idle = detail.rows { detail.loadRows() }
                _ = await waitUntil(60) { detail.rows.value != nil || detail.rows.failure != nil }
                if let id = request.edit, let row = detail.rows.value?.rows.first(where: { $0.id == id }) {
                    detail.selectedRow = id
                    detail.edit(row)
                } else if let id = request.select {
                    detail.selectedRow = id
                }
                if let step = request.suggestProgress {
                    detail.busy.insert("suggest")
                    detail.suggestProgress = step
                }
            }
            if let name = request.undoPerson {
                // What Remove and its notice's Undo leave: the person goes, Undo puts them back, and the picture shows
                // the notice once the undo answered.
                guard canonicalHome(GenesisToolsHome.home()) != canonicalHome(NSHomeDirectory()),
                      let detail = model.detail, request.meeting == detail.id,
                      let record = detail.record.value, record.id == detail.id, record.copySource != nil,
                      record.participants?.contains(where: { $0.name == name }) == true else {
                    FileHandle.standardError.write(Data("meetings snapshot: --undo-person needs an existing participant of an explicit --meeting copy in an isolated GENESIS_TOOLS_HOME\n".utf8))
                    exit(1)
                }
                do {
                    try await detail.removePersonStay(PersonStay.of(name, in: record))
                } catch {
                    FileHandle.standardError.write(Data("meetings snapshot: removing \(name) failed: \(error)\n".utf8))
                    exit(1)
                }
                guard let notice = detail.notices.notices.last, let undo = notice.actions.first(where: { $0.label == "Undo" }) else {
                    FileHandle.standardError.write(Data("meetings snapshot: removing the participant produced no Undo action\n".utf8))
                    exit(1)
                }
                detail.notices.press(undo, of: notice.id)
                let settled = await waitUntil(10) { detail.notices.waiting[notice.id] == nil }
                let text = detail.notices.notice(notice.id)?.text ?? "gone"
                FileHandle.standardError.write(Data("meetings snapshot: the undo notice reads \"\(text)\", \(settled ? "settled" : "still waiting after 10 s")\n".utf8))
                guard settled, text.hasPrefix("Undone:") else { exit(1) }
            }
            if let text = request.notice, let detail = model.detail {
                detail.notices.push(StackedNotice(text: text, actions: [.undo { [weak notices = detail.notices] id in
                    notices?.push(StackedNotice(text: "Undone"), replacing: id)
                }]))
            }
            if let target = request.play {
                guard let meeting = model.detail?.id else {
                    FileHandle.standardError.write(Data("meetings snapshot: --play needs --meeting\n".utf8))
                    exit(1)
                }
                model.player.play(target, in: meeting, from: .row)
                guard await waitUntil(60, { model.player.phase == .playing || model.player.isFailed }) else {
                    FileHandle.standardError.write(Data("meetings snapshot timed out cutting the Moment\n".utf8))
                    exit(1)
                }
                // A failed cut is pictured too (its pill is part of what the dock shows); stderr names it.
                if case .failed(let failure) = model.player.phase {
                    FileHandle.standardError.write(Data("meetings snapshot: the Moment did not play: \(failure.sentence)\n".utf8))
                }
            }
            if let range = request.show {
                guard let meeting = model.detail?.id else {
                    FileHandle.standardError.write(Data("meetings snapshot: --show needs --meeting\n".utf8))
                    exit(1)
                }
                model.player.showMeeting(meeting, from: range.lowerBound)
                model.player.timeline.showView(range, layer: model.player.top?.id)
                guard await waitUntil(60, { model.player.phase == .playing || model.player.isFailed }) else {
                    FileHandle.standardError.write(Data("meetings snapshot timed out starting the meeting\n".utf8))
                    exit(1)
                }
            }
            for range in request.zoomTo {
                model.player.timeline.pushView(range, layer: model.player.top?.id)
            }
            if request.play != nil || request.show != nil, let detail = model.detail {
                // The dock's waveform has the speakers' colours, which it reads after it shows.
                if case .idle = detail.speakers { detail.loadSpeakers() }
                _ = await waitUntil(60) { detail.speakers.value != nil || detail.speakers.failure != nil }
            }
            if model.sidePanelOpen {
                _ = await waitUntil(30) { model.settingsRaw != nil || model.settings.failure != nil }
            }
            if case .projectVoices(let name) = model.place {
                guard await prepareLibrarySnapshot(.project(name), model: model) else { exit(1) }
            }
            if request.voices != nil || request.voicesProgress != nil, let detail = model.detail {
                let voices = detail.voices
                voices.open = true
                if let project = detail.record.value?.project {
                    if request.voices == "meeting" { voices.meetingOnlyOverride = true }
                    voices.focus = request.voiceFocus
                    if request.voices == "project" { voices.meetingOnlyOverride = false }
                    let only = voices.meetingOnlyOverride ?? model.defaults.bool(forKey: MeetingsVoiceCompute.meetingOnlyKey)
                    guard await prepareLibrarySnapshot(.inspector(meeting: detail.id, project: project, meetingOnly: only), model: model) else { exit(1) }
                } else if request.voices == "meeting" || request.voiceJobFile != nil {
                    FileHandle.standardError.write(Data("meetings snapshot: the selected meeting has no project\n".utf8))
                    exit(1)
                }
                if request.voices == "preview" {
                    voices.runPreview()
                    // A cold voice pass of a 172-minute meeting takes up to 90 s with one worker.
                    _ = await waitUntil(150) { voices.running == nil }
                }
                if let step = request.voicesProgress {
                    voices.running = .preview
                    voices.progress = step
                }
            }
            let window: NSWindow
            let fullWindow = request.card == nil && (request.sheet == nil || request.sheet == "room-devices")
            if !fullWindow {
                guard let part = await meetingsSnapshotPart(request, model: model, offers: offers) else {
                    FileHandle.standardError.write(Data("meetings snapshot: no such part (--card needs a row id of --meeting, --sheet takes history, history:<row id>, voice-tools, word-timings, link-source, seats, room-devices, voice-library-settings, selection:<from>-<to>, person:<name> or person-voices:<name or email>)\n".utf8))
                    exit(1)
                }
                window = MeetingsWindow.partWindow(part)
            } else {
                window = MeetingsWindow.makeWindow(model: model, size: NSSize(width: request.width, height: request.height), roomDevices: roomDevices)
            }
            window.orderInForSnapshot()
            try? await Task.sleep(for: .milliseconds(900))
            if let sheet = request.sheet, sheet.hasPrefix("selection:"), let detail = model.detail {
                // A redraw while the popover is open, as a busy key or the playback makes one: the main thread's busy
                // time of ten redraws (`meetings.transcript.selection.redraw … main busy`).
                for round in 1...10 {
                    HubMainBusy.measure("meetings.transcript.selection.redraw")
                    if round % 2 == 1 { detail.busy.insert("clip.save") } else { detail.busy.remove("clip.save") }
                    try? await Task.sleep(for: .milliseconds(700))
                }
            }
            if fullWindow, let top = model.player.top {
                // The dock reads its waveform once it shows, after the reads the window sent before it (the service
                // answers in order): a picture taken before they land showed a timeline without a waveform.
                let dock = model.player.timeline
                if await waitUntil(8, { dock.whole[top.meeting] != nil }) {
                    try? await Task.sleep(for: .milliseconds(400))
                }
            }
            if fullWindow {
                // The flags name the entire window, not its content rect. SwiftUI installs a toolbar after the
                // first layout, adding 66 pt (80 with the dock) to the initial content size. Resize only after
                // those views are present so snapshots at the same requested size remain comparable.
                let size = MeetingsWindow.floored(NSSize(width: request.width, height: request.height))
                window.setFrame(NSRect(origin: window.frame.origin, size: size), display: true)
                window.contentView?.layoutSubtreeIfNeeded()
                try? await Task.sleep(for: .milliseconds(200))
            }
            if request.voices != nil || request.voiceSample != nil || request.voiceJobFile != nil {
                // The resize above re-creates the sample list, whose onDisappear hides the library: the list reads
                // its samples again, and a picture taken before that read showed only "Reading voice samples…".
                let library = model.voiceLibrary
                if await waitUntil(30, { library.destination != nil && (library.rows.value != nil || library.rows.failure != nil) }) {
                    try? await Task.sleep(for: .milliseconds(300))
                }
            }
            guard let capture = await WindowSnapshot.capture(window),
                  let png = capture.image.representation(using: .png, properties: [:]) else {
                FileHandle.standardError.write(Data("meetings snapshot failed: the window could not be drawn\n".utf8))
                exit(1)
            }
            do {
                try png.write(to: URL(fileURLWithPath: path))
            } catch {
                FileHandle.standardError.write(Data("meetings snapshot failed: \(error.localizedDescription)\n".utf8))
                exit(1)
            }
            FileHandle.standardError.write(Data("meetings snapshot: \(path) by \(capture.method)\n".utf8))
            exit(0)
        }
        NSApp.run()
    }
    exit(0)
}

/// The Meetings window's undo manager (G39). A text field in focus (the field editor is the first responder) keeps its
/// own undo; otherwise ⌘Z and Edit → Undo press the newest notice's Undo, and the menu item names it.
final class MeetingsUndoManager: UndoManager {
    weak var window: NSWindow?
    private weak var model: MeetingsWindowModel?

    init(model: MeetingsWindowModel) {
        self.model = model
        super.init()
    }

    private var textHasFocus: Bool {
        MainActor.assumeIsolated { window?.firstResponder is NSText }
    }

    private var noticeUndo: String? {
        MainActor.assumeIsolated { model?.newestUndo }
    }

    override var canUndo: Bool { textHasFocus ? super.canUndo : noticeUndo != nil }

    override var undoMenuItemTitle: String {
        guard !textHasFocus else { return super.undoMenuItemTitle }
        return noticeUndo.map { "Undo \($0)" } ?? "Undo"
    }

    override func undo() {
        guard !textHasFocus else { return super.undo() }
        MainActor.assumeIsolated { _ = model?.undoNewest() }
    }
}
