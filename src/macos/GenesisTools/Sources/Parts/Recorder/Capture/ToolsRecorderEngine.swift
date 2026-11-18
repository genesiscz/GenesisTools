import AppKit
import Foundation

/// A bar controls only the live ID printed by its own recorder start (or explicitly passed by the status item).
@MainActor
final class ToolsRecorderEngine: RecordingEngineAdapter {
    typealias RPC = @MainActor (LiveRecording, String, [String: Any]) async throws -> Any?
    typealias Launch = @MainActor ([String], @escaping @MainActor ([String]) -> Void,
                                   @escaping @MainActor (Int32, String) -> Void) throws -> DetachedToolsJob?

    let events: AsyncStream<RecordingEngineEvent>
    private let output: AsyncStream<RecordingEngineEvent>.Continuation
    private(set) var nextTakeID = UUID().uuidString
    private(set) var entry: LiveRecording?
    private(set) var liveID: String?
    var threshold = CaptureOptions.load().threshold
    var shortcuts = RecorderMenu.recordsShortcuts
    private let launch: Launch
    private let rpc: RPC
    typealias Preparation = (previewWindows: [Int], release: @MainActor () -> Void)
    private let prepare: @MainActor (CameraSetup) async throws -> Preparation
    private let locate: (String) async -> LiveRecording?
    private let foreign: Bool
    private let startupTimeout: Duration
    private var startup: CheckedContinuation<Void, Error>?
    private var startupDeadline: Task<Void, Never>?
    private var take: String?
    private var stream: DetachedToolsJob?
    private var launchID: UUID?
    private var started: CheckedContinuation<String, Error>?
    private var terminal: (answer: Result<URL?, Error>, event: RecordingEngineEvent.Value)?
    private var result: Result<URL?, Error>? { terminal?.answer }
    private var finishing: CheckedContinuation<URL?, Error>?
    private var setup = RecordingSetup()
    private var recordedSources = Set<LiveRecordingCommand.Source>()
    private var paused = false
    private var switching = false
    private var awaitingRestart = false
    private var needsRestartFrame = false
    private var framing = false
    private var watcher: LiveRecordingsWatcher?
    private var releasePreparation: (@MainActor () -> Void)?
    var followedDisplay: RecordingDisplay? {
        guard let display = entry?.displays.first, let id = UInt32(exactly: display.id),
              let index = CaptureChoice.screenIDs.firstIndex(of: id),
              NSScreen.screens.indices.contains(index) else { return nil }
        let screen = NSScreen.screens[index]
        return RecordingDisplay(index: index, name: display.name, isPrimary: index == 0,
                                width: screen.frame.width, height: screen.frame.height)
    }

    init(adopting entry: LiveRecording? = nil,
         prepare: (@MainActor (CameraSetup) async throws -> Preparation)? = nil,
         launch: Launch? = nil, rpc: RPC? = nil, locate: ((String) async -> LiveRecording?)? = nil,
         startupTimeout: Duration = .seconds(90)) {
        (events, output) = AsyncStream.makeStream(of: RecordingEngineEvent.self)
        foreign = entry != nil
        self.startupTimeout = startupTimeout
        self.entry = entry
        liveID = entry?.id
        self.prepare = prepare ?? { camera in
            let need = PermissionNeed(.screenRecording, reason: "The recorder records the screen you choose.",
                                      grantWorksInNewProcess: true)
            guard await PermissionCenter.shared.ensure(need) else {
                throw RecordingEngineError.unsupported("Allow Screen Recording to start a recording.")
            }
            guard camera.enabled else { return ([], {}) }
            let restore = Self.useCameraAppearance(camera, defaults: .standard) { CameraBubble.shared.appearanceChanged() }
            let windows = await CameraBubble.shared.previewForStart()
            CameraBubble.shared.pickerClosed(started: true, previewLeftOut: !windows.isEmpty)
            return (windows, {
                restore()
                CameraBubble.shared.pickerClosed(started: false)
            })
        }
        self.launch = launch ?? { arguments, lines, exit in
            try RecorderMenu.shared.startRecording(arguments: arguments, onLines: lines, onExit: exit)
        }
        self.rpc = rpc ?? { entry, method, params in
            guard let socket = entry.socket else { throw RecordingEngineError.unsupported("This recording has no control socket.") }
            let client = LiveRecordingRPCClient(path: socket)
            try client.connect()
            defer { client.close() }
            return try await client.call(method, params: params, timeout: method == "stop" ? 180 : 10)
        }
        self.locate = locate ?? { id in
            await Task.detached {
                guard !id.contains("/"), !id.isEmpty else { return nil as LiveRecording? }
                let file = LiveRecordingStore.live.folder.appendingPathComponent(id + ".json")
                guard let data = try? Data(contentsOf: file),
                      let entry = LiveRecordingStore.decode(data), entry.id == id else { return nil }
                return entry
            }.value
        }
    }

    var capabilities: RecordingCapabilities {
        Self.capabilities(methods: entry.map { Set($0.controls) }, recordedSources: recordedSources)
    }

    static func capabilities(methods: Set<String>?, recordedSources: Set<LiveRecordingCommand.Source>) -> RecordingCapabilities {
        func supports(_ name: String) -> Bool { methods?.contains(name) ?? true }
        let frames = methods?.contains("displays.add") == true
        var targets = Set(RecordingTargetKind.allCases)
        if frames { targets = [.display, .displays] }
        else if methods != nil { targets.remove(.displays) }
        // A window or app movie never carries sound in this recorder, before a take as well as during it.
        var reasons = [
            "camera": "The camera starts with the recording",
            "windowAudio": "A window movie has no audio. Choose a display or an area to record sound.",
            "appAudio": "An app movie has no audio. Choose a display or an area to record sound.",
        ]
        if !supports("restart") { reasons["restart"] = "This recorder does not offer Restart." }
        if !supports("audio.mute") {
            reasons["microphone"] = "This recorder keeps the audio sources chosen at start."
            reasons["systemAudio"] = reasons["microphone"]
        }
        if !supports("audio.setInput") { reasons["microphoneDevice"] = "This recorder keeps the microphone chosen at start." }
        let mic = methods == nil || recordedSources.contains(.mic)
        let system = methods == nil || recordedSources.contains(.system)
        if !mic { reasons["microphone"] = "This take has no microphone track." }
        if !system { reasons["systemAudio"] = "This take has no system audio track." }
        return RecordingCapabilities(targets: targets, liveTargetSwitch: supports("target.switch") || frames,
                                     liveMicrophoneMute: mic && supports("audio.mute"), liveMicrophoneDevice: mic && supports("audio.setInput"),
                                     liveSystemAudioMute: system && supports("audio.mute"), liveFrameRate: supports("settings.set"),
                                     liveCamera: false, liveDisplaysAddRemove: supports("displays.add") && supports("displays.remove"),
                                     liveRestart: supports("restart"),
                                     reasonUnavailable: reasons)
    }

    func start(_ setup: RecordingSetup, excludeWindowIDs: [Int]) async throws {
        self.setup = setup
        recordedSources = []
        if setup.microphone.enabled, foreign || !setup.microphone.muted { recordedSources.insert(.mic) }
        if setup.systemAudio.enabled, foreign || !setup.systemAudio.muted { recordedSources.insert(.system) }
        take = nextTakeID
        nextTakeID = UUID().uuidString
        terminal = nil
        framing = false
        paused = false
        awaitingRestart = false
        needsRestartFrame = false
        if foreign {
            guard let entry else { throw RecordingEngineError.unsupported("This recording has ended.") }
            observe(entry)
            return
        }
        let token = UUID()
        launchID = token
        entry = nil
        liveID = nil
        try await withCheckedThrowingContinuation { continuation in
            startup = continuation
            startupDeadline = Task { [weak self, startupTimeout] in
                do { try await Task.sleep(for: startupTimeout) } catch { return }
                self?.finishStartup(token, with: .failure(RecordingEngineError.unsupported("The recorder did not finish starting in time.")))
            }
            Task {
                do {
                    try await self.startOwned(setup, excluding: excludeWindowIDs, token: token)
                    self.finishStartup(token, with: .success(()))
                } catch {
                    self.finishStartup(token, with: .failure(error))
                }
            }
        }
    }

    private func startOwned(_ setup: RecordingSetup, excluding excludeWindowIDs: [Int], token: UUID) async throws {
        let preparation = try await prepare(setup.camera)
        guard launchID == token, result == nil else {
            preparation.release()
            return
        }
        releasePreparation = preparation.release
        let ids = Array(Set(excludeWindowIDs + preparation.previewWindows)).filter { $0 > 0 }.sorted()
        let args = try CaptureOptions.barArguments(setup, threshold: threshold, shortcuts: shortcuts, excluding: ids,
                                                   screens: NSScreen.screens.map(\.frame), displayIDs: CaptureChoice.screenIDs)
        let id: String = try await withCheckedThrowingContinuation { continuation in
            started = continuation
            do {
                stream = try launch(args, { [weak self] lines in
                    guard let self, self.launchID == token else { return }
                    self.receive(lines)
                }, { [weak self] status, error in
                    guard let self, self.launchID == token else { return }
                    self.exited(status: status, error: error)
                })
            } catch {
                started = nil
                continuation.resume(throwing: error)
            }
        }
        guard let found = await locate(id) else {
            throw RecordingEngineError.unsupported("The recorder did not publish its control socket.")
        }
        if let result {
            _ = try result.get()
            throw RecordingEngineError.unsupported("The recording ended before its controls became available.")
        }
        guard launchID == token else { return }
        entry = found
        if found.kind == "library" {
            let watcher = LiveRecordingsWatcher()
            self.watcher = watcher
                watcher.onRefresh = { [weak self] list in
                    if let current = list.first(where: { $0.id == id }) { self?.observe(current) }
                }
                watcher.start()
            }
    }

    private func finishStartup(_ token: UUID, with answer: Result<Void, Error>) {
        guard launchID == token, let startup else { return }
        self.startup = nil
        startupDeadline?.cancel()
        startupDeadline = nil
        if case let .failure(error) = answer {
            launchID = nil
            stream?.stop()
            stream = nil
            complete(.failure(error))
        }
        startup.resume(with: answer)
    }

    /// CameraBubble reads these two existing keys both for the preview and when writing the edit's placement.
    /// Override only those keys in this process for the take; the saved defaults stay under the volatile domain.
    static func useCameraAppearance(_ camera: CameraSetup, defaults: UserDefaults, changed: @escaping () -> Void) -> () -> Void {
        let domain = UserDefaults.argumentDomain
        var values = defaults.volatileDomain(forName: domain)
        let size = values[CameraBubble.Key.size], shape = values[CameraBubble.Key.shape]
        values[CameraBubble.Key.size] = camera.size
        values[CameraBubble.Key.shape] = camera.shape
        defaults.setVolatileDomain(values, forName: domain)
        changed()
        return {
            var values = defaults.volatileDomain(forName: domain)
            values[CameraBubble.Key.size] = size
            values[CameraBubble.Key.shape] = shape
            defaults.setVolatileDomain(values, forName: domain)
            changed()
        }
    }

    func observe(_ recording: LiveRecording) {
        guard recording.id == liveID else { return }
        entry = recording
        let sessionHasFrames = recording.kind == "control-session" && recording.recordedMs.map {
            $0 > 0 || recording.recordedRunning
        } == true
        if !needsRestartFrame && (CaptureCountdown.hasFirstFrame(recording) || sessionHasFrames || (foreign && recording.isPaused)) {
            firstFrame()
        }
        if recording.isPaused != paused { paused = recording.isPaused; emit(paused ? .paused : .resumed) }
        if framing { emit(.elapsed(milliseconds: recording.elapsedMs(now: Date()))) }
    }

    private func receive(_ lines: [String]) {
        for line in lines {
            guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
            switch object["event"] as? String {
            case "started":
                if let id = (object["liveId"] ?? object["id"]) as? String, started != nil {
                    liveID = id
                    started?.resume(returning: id)
                    started = nil
                }
            case "state":
                let state = object["state"] as? String
                if awaitingRestart {
                    guard state == "starting", object["elapsedMs"] as? Double == 0 else { continue }
                    awaitingRestart = false
                }
                if state == "recording" {
                    needsRestartFrame = false
                    firstFrame()
                    if !switching, paused { paused = false; emit(.resumed) }
                } else if state == "paused" {
                    paused = true
                    if switching { switching = false } else { emit(.paused) }
                }
                if let elapsed = object["elapsedMs"] as? Double { emit(.elapsed(milliseconds: elapsed)) }
            case "elapsed":
                if !awaitingRestart, let ms = object["elapsedMs"] as? Double { emit(.elapsed(milliseconds: ms)) }
            case "warning", "error":
                if let message = object["message"] as? String { emit(.warning(message)) }
            case "result":
                switch object["outcome"] as? String {
                case "discarded": complete(.success(nil), discarded: true)
                case "failed":
                    let reason = (object["warnings"] as? [String])?.first ?? "The recording failed."
                    complete(.failure(RecordingEngineError.unsupported(reason)))
                default:
                    complete(.success((object["folder"] as? String).map { URL(fileURLWithPath: $0, isDirectory: true) }))
                }
            default: break
            }
        }
    }

    private func firstFrame() {
        guard !framing else { return }
        framing = true
        emit(.firstFrame)
    }

    private func emit(_ value: RecordingEngineEvent.Value) {
        if let take { output.yield(.init(take: take, value: value)) }
    }

    private func exited(status: Int32, error: String) {
        if result == nil {
            let reason = ToolsRunner.problem(in: error) ?? "The recorder exited (\(status)) without a result."
            complete(.failure(RecordingEngineError.unsupported(reason)))
        }
        stream = nil
    }

    private func complete(_ answer: Result<URL?, Error>, discarded: Bool = false) {
        guard terminal == nil else { return }
        let event: RecordingEngineEvent.Value
        switch answer {
        case let .failure(error): event = .failed(error.localizedDescription)
        case let .success(url): event = discarded ? .discarded : .stopped(url)
        }
        terminal = (answer, event)
        if let started {
            self.started = nil
            switch answer {
            case let .failure(error): started.resume(throwing: error)
            case .success: started.resume(throwing: RecordingEngineError.unsupported("The recording ended before it started."))
            }
        }
        finishing?.resume(with: answer)
        finishing = nil
        emit(event)
        watcher?.stop()
        watcher = nil
        releasePreparation?()
        releasePreparation = nil
        entry = nil
        liveID = nil
    }

    @discardableResult
    private func call(_ method: String, _ params: [String: Any] = [:]) async throws -> Any? {
        guard let entry else { throw RecordingEngineError.unsupported("The recording has no live connection.") }
        return try await rpc(entry, method, params)
    }

    @discardableResult
    private func send(_ command: LiveRecordingCommand) async throws -> Any? {
        try await call(command.rawValue, command.parameters)
    }

    func pause() async throws { try await send(.pause); paused = true }
    func resume() async throws { try await send(.resume); paused = false }

    func stop() async throws -> URL? {
        let folder = entry?.folder
        let answer: Any?
        do { answer = try await send(.stop) }
        catch { if let result { return try result.get() }; throw error }
        if foreign {
            let state = answer as? [String: Any]
            let outcome = state?["outcome"] as? String
            guard state?["state"] as? String == "stopped", outcome != "failed", outcome != "discarded" else {
                throw RecordingEngineError.unsupported("The recorder did not confirm a saved recording.")
            }
            return folder.map { URL(fileURLWithPath: $0, isDirectory: true) }
        }
        return try await finalResult()
    }

    func discard() async throws {
        do { try await call("discard") }
        catch { if let result { _ = try result.get(); return }; throw error }
        if !foreign { _ = try await finalResult() }
    }

    private func finalResult() async throws -> URL? {
        if let result { return try result.get() }
        return try await withCheckedThrowingContinuation { finishing = $0 }
    }

    func restart() async throws {
        guard capabilities.liveRestart else {
            throw RecordingEngineError.unsupported("This recorder does not offer Restart.")
        }
        let old = take, wasFraming = framing
        take = nextTakeID
        nextTakeID = UUID().uuidString
        awaitingRestart = !foreign
        needsRestartFrame = !foreign
        framing = false
        do { try await call("restart") }
        catch {
            awaitingRestart = false
            needsRestartFrame = false
            if let terminal { throw RecordingEngineError.restartEnded(terminal.event) }
            take = old
            framing = wasFraming
            throw error
        }
    }

    func addMarker() async throws { try await send(.marker) }

    func apply(_ change: RecordingSetupChange) async throws {
        if let reason = capabilities.unavailableReason(for: change, in: setup) {
            throw RecordingEngineError.unsupported(reason)
        }
        switch change {
        case let .microphone(mic):
            if mic.deviceID != setup.microphone.deviceID {
                guard let device = mic.deviceID ?? AudioDevices.systemDefaultInput()?.uid else {
                    throw RecordingEngineError.unsupported("There is no system default microphone.")
                }
                try await send(.setInput(deviceID: device))
                setup.microphone.deviceID = mic.deviceID
            }
            if mic.muted != setup.microphone.muted { try await send(mic.muted ? .mute(.mic) : .unmute(.mic)) }
            setup.microphone = mic
        case let .systemAudio(audio):
            try await send(audio.muted ? .mute(.system) : .unmute(.system))
            setup.systemAudio = audio
        case let .frameRate(active, still):
            let same = still == 0 || still == Double(active)
            if same, setup.stillFrameRate != 0 && setup.stillFrameRate != Double(setup.frameRate), active > 5 {
                throw RecordingEngineError.unsupported("The running recorder accepts an explicit still rate up to 5 fps. Choose Same before recording.")
            }
            try await send(.setFrameRate(active: active, still: same ? (active <= 5 ? Double(active) : 0) : still))
            setup.frameRate = active
            setup.stillFrameRate = still
        case let .target(target):
            try await switchTarget(target)
            setup.target = target
        case .camera, .quality, .drawsCursor:
            throw RecordingEngineError.unsupported(capabilities.reasonUnavailable[change.controlID] ?? "Choose this setting before recording.")
        }
    }

    private func switchTarget(_ target: RecordingTarget) async throws {
        if entry?.controls.contains("displays.add") == true {
            let indices: [Int]
            switch target {
            case let .displays(selected): indices = selected
            case let .display(index, _): indices = [index]
            default: throw RecordingEngineError.unsupported("A frames recording records displays.")
            }
            let ids = CaptureChoice.screenIDs
            let wanted = try Set(indices.map { index -> Int64 in
                guard ids.indices.contains(index), let id = ids[index] else {
                    throw RecordingEngineError.unsupported("A selected display disconnected.")
                }
                return Int64(id)
            })
            guard !wanted.isEmpty else { throw RecordingEngineError.unsupported("Choose at least one display.") }
            // Query each time: a failed second operation or another client's edit must be safe to retry.
            let answer = try await call("displays.list")
            guard let displays = answer as? [[String: Any]] else { throw RecordingEngineError.unsupported("Could not read the recorded displays.") }
            let existing = Set(displays.compactMap { $0["recorded"] as? Bool == true ? ($0["id"] as? NSNumber)?.int64Value : nil })
            for id in wanted.subtracting(existing).sorted() { try await call("displays.add", ["displayId": id]) }
            for id in existing.subtracting(wanted).sorted() { try await call("displays.remove", ["displayId": id]) }
            return
        }
        let wire: Any
        if target.kind == .area {
            let screens = NSScreen.screens.map(\.frame)
            guard let primary = screens.first, let cocoa = target.areaBounds(screens: screens, displayIDs: CaptureChoice.screenIDs) else {
                throw RecordingEngineError.unsupported("The selected display disconnected. Choose the area again.")
            }
            let region = CaptureChoice.coreGraphicsRect(cocoa: cocoa, primaryHeight: primary.maxY)
            wire = ["kind": "region", "x": region.minX, "y": region.minY, "width": region.width, "height": region.height] as [String: Any]
        } else {
            wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(target))
        }
        let keepPaused = paused
        switching = keepPaused && !foreign
        do { try await call("target.switch", ["target": wire]) }
        catch { switching = false; throw error }
        guard keepPaused else { return }
        do {
            try await call("pause")
        } catch {
            switching = false
            guard result == nil else { throw error }
            let state = (try? await call("status")) as? [String: Any]
            if state?["state"] as? String == "paused" {
                paused = true
                return
            }
            guard result == nil else { throw error }
            paused = false
            setup.target = target
            throw RecordingEngineError.partialTargetSwitch(target, "The target switched but could not be paused: \(error.localizedDescription)")
        }
    }

    func audioDevices() async throws -> (inputs: [RecordingAudioDevice], outputs: [RecordingAudioDevice]) {
        if entry?.controls.contains("audio.list") == true {
            let reply = try await call("audio.list")
            struct Devices: Decodable { var inputs: [RecordingAudioDevice]; var outputs: [RecordingAudioDevice] }
            let data = try JSONSerialization.data(withJSONObject: reply ?? NSNull())
            let devices = try JSONDecoder().decode(Devices.self, from: data)
            return (devices.inputs, devices.outputs)
        }
        return await Task.detached {
            let uid = AudioDevices.systemDefaultInput()?.uid
            let inputs = AudioDevices.inputs().map { RecordingAudioDevice(id: $0.uid, name: $0.name, isDefault: $0.uid == uid) }
            let defaultOutput = AudioOutputs.systemDefaultID()
            let outputs = AudioOutputs.outputs().map { RecordingAudioDevice(id: $0.uid, name: $0.name, isDefault: $0.id == defaultOutput) }
            return (inputs, outputs)
        }.value
    }

    /// Adopt the running recorder's own settings. Opening the controls never sends a start or changes a preference.
    func adoptedSetup() async throws -> RecordingSetup {
        guard let entry, let answer = try await call("settings.get") as? [String: Any],
              let rates = answer["settings"] as? [String: Any], let active = rates["activeFps"] as? NSNumber,
              let audio = answer["audio"] as? [String: Any], let sources = audio["sources"] as? [String] else {
            throw RecordingEngineError.unsupported("This recording did not report its current settings.")
        }
        var setup = RecordingSetup(countdownSeconds: nil)
        setup.frameRate = active.intValue
        let still = (rates["idleFps"] as? NSNumber)?.doubleValue ?? active.doubleValue
        setup.stillFrameRate = still == active.doubleValue ? 0 : still
        let muted = audio["muted"] as? [String: Bool]
        setup.microphone = .init(enabled: sources.contains("mic"), muted: muted?["mic"] == true,
                                 deviceID: audio["micDevice"] as? String)
        setup.systemAudio = .init(enabled: sources.contains("system"), muted: muted?["system"] == true)
        let ids = CaptureChoice.screenIDs
        let indices = entry.displays.compactMap { display in UInt32(exactly: display.id).flatMap { ids.firstIndex(of: $0) } }
        if indices.count > 1 { setup.target = .displays(indices: indices) }
        else if let index = indices.first { setup.target = .display(index: index, name: entry.displays.first?.name) }
        if let folder = entry.folder {
            let data = await Task.detached {
                try? Data(contentsOf: URL(fileURLWithPath: folder).appendingPathComponent("recording.json"))
            }.value
            if let data, let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let settings = manifest["settings"] as? [String: Any] {
                setup.camera.enabled = (settings["camera"] as? [String: Any])?["requested"] as? Bool == true
                setup.drawsCursor = settings["cursor"] as? String == "drawn"
                if let target = settings["target"] as? [String: Any] {
                    if target["follow"] as? Bool == true { setup.target = nil }
                    else if let encoded = try? JSONSerialization.data(withJSONObject: target),
                       let decoded = try? JSONDecoder().decode(RecordingTarget.self, from: encoded) { setup.target = decoded }
                }
            }
        }
        return setup
    }
}
