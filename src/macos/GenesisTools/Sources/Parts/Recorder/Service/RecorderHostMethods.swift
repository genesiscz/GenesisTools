import AppKit

/// What the host's methods act on in this app: the editor windows, the library, the picker and the camera bubble.
/// `LiveRecorderFace` is the running recorder face; a test passes a fake, so no window or camera starts there.
@MainActor
protocol RecorderHostFace: AnyObject {
    /// Opens (or brings back) the editor of `path` and answers its window number.
    func openEditor(path: String, focus: Bool, atSeconds: Double?, tab: InspectorTab?) async throws -> Int
    func showLibrary(focus: Bool)
    func showPicker()
    /// `{ front?, open: [{ path, title, window }] }`, the rows editor-open.json holds.
    func openWindows() -> [String: Any]
    /// Closes the editor `path` names (its folder, edit or movie) or window number `window`, and answers its number;
    /// nil when no editor shows it. Throws `Code.windowBusy` while the window has a drag not saved yet or an export.
    func closeEditor(path: String?, window: Int?) throws -> Int?
    func startCamera(folder: URL) async -> CameraBubble.StartAnswer
    func stopCamera(folder: URL) -> Bool
}

/// The methods the recorder host answers for the recorder service (the plan's "Methods the host answers"):
/// `window.open`, `window.show`, `window.list`, `window.close`, `render.still`, `render.sheet`, `render.export`, `render.snapshot`,
/// `camera.start` and `camera.stop`. Each runs on the main actor and calls the code the face already has; renders
/// answer the fields the headless `--still`, `--sheet`, `--export --json` and `--snapshot` runs print.
enum RecorderHostMethods {
    typealias Handler = LiveRecordingRPCClient.Handler
    typealias Failure = LiveRecordingRPCClient.Failure

    /// The last `render.snapshot` in line; the next one starts after it.
    @MainActor private static var snapshotQueue: Task<Void, Never>?

    static func table(face: RecorderHostFace) -> [String: Handler] {
        [
            "window.open": method { request in
                let params = Params(request)
                let tab = try params.tab()
                let window = try await face.openEditor(path: try params.path("path"), focus: params.bool("focus") ?? true,
                                                       atSeconds: params.number("atSeconds"), tab: tab)
                return ["opened": true, "window": window]
            },
            "window.show": method { request in
                let params = Params(request)
                switch try params.string("which") {
                case "library": face.showLibrary(focus: params.bool("focus") ?? true)
                case "picker": face.showPicker()
                case let other: throw invalid("window.show: which is \"library\" or \"picker\", not \"\(other)\"")
                }
                return ["shown": true]
            },
            "window.list": method { _ in face.openWindows() },
            "window.close": method { request in
                let params = Params(request)
                let path = try params.optionalPath("path")
                let window = params.int("window")
                guard path != nil || window != nil else {
                    throw invalid("window.close needs path (a recording folder, its edit or its movie) or window (a number window.list names)")
                }
                guard let closed = try face.closeEditor(path: path, window: window) else { return ["closed": false] }
                return ["closed": true, "window": closed]
            },
            "render.still": method { request in
                let params = Params(request)
                return try await RecorderRenders.still(source: try params.path("path"), atSeconds: params.number("atSeconds") ?? 0,
                                                       out: try params.optionalPath("out"), full: params.bool("full") ?? false)
            },
            "render.sheet": method { request in
                let params = Params(request)
                let times = (request.object["times"] as? [Any])?.compactMap { ($0 as? NSNumber)?.doubleValue } ?? []
                guard !times.isEmpty else { throw invalid("render.sheet needs times: a list of output seconds") }
                return try await RecorderRenders.sheet(source: try params.path("path"), times: times, out: try params.optionalPath("out"))
            },
            "render.export": method { request in
                let params = Params(request)
                var percent = -1
                let result = try await RecorderRenders.export(source: try params.path("path"), out: try params.optionalPath("out"),
                                                              isCancelled: { request.isCancelled }) { fraction in
                    let now = Int(fraction * 100)
                    guard now != percent else { return }
                    percent = now
                    request.progress(fraction: fraction, label: "export")
                }
                return RecorderRenders.exportAnswer(result)
            },
            "render.snapshot": method { request in
                let params = Params(request)
                let out = try params.path("out")
                let snapshot = try params.snapshotRequest()
                // One at a time: a snapshot closes the snapshot windows it finds when it ends, a second one's included.
                let previous = snapshotQueue
                let job = Task { @MainActor in
                    await previous?.value
                    return try await RecorderRenders.snapshot(snapshot, to: out)
                }
                snapshotQueue = Task { _ = try? await job.value }
                let method = try await job.value
                return ["ok": true, "path": out, "method": method]
            },
            "camera.start": method { request in
                let folder = try Params(request).folder()
                switch await face.startCamera(folder: folder) {
                case .started: return ["started": true]
                case .denied:
                    throw Failure.remote(code: RecorderServiceHost.Code.cameraDenied,
                                         message: "Camera access is off for GenesisTools (System Settings → Privacy & Security → Camera)")
                case let .busy(other):
                    throw Failure.remote(code: RecorderServiceHost.Code.cameraBusy, message: "the camera records \(other) already")
                }
            },
            "camera.stop": method { request in
                ["stopped": face.stopCamera(folder: try Params(request).folder())]
            },
        ]
    }

    /// A handler that runs `body` on the main actor and answers with its value or its error.
    private static func method(_ body: @escaping @MainActor (LiveRecordingRPCClient.Incoming) async throws -> Any?) -> Handler {
        { request, reply in
            Task { @MainActor in
                do {
                    reply(.success(try await body(request)))
                } catch {
                    reply(.failure(error))
                }
            }
        }
    }

    static func invalid(_ message: String) -> Failure {
        .remote(code: LiveRecordingRPCClient.Code.invalidParams, message: message)
    }

    /// A request's params, read with the refusals the service passes on as -32602.
    struct Params {
        let method: String
        let object: [String: Any]

        init(_ request: LiveRecordingRPCClient.Incoming) {
            self.init(method: request.method, object: request.object)
        }

        init(method: String, object: [String: Any]) {
            self.method = method
            self.object = object
        }

        func string(_ key: String) throws -> String {
            guard let value = object[key] as? String, !value.isEmpty else { throw invalid("\(method) needs \(key)") }
            return value
        }

        func number(_ key: String) -> Double? { (object[key] as? NSNumber)?.doubleValue }
        func int(_ key: String) -> Int? { (object[key] as? NSNumber)?.intValue }
        func bool(_ key: String) -> Bool? { (object[key] as? NSNumber)?.boolValue }

        /// An absolute path (`~` expanded), standardized as the face's `--edit` takes it.
        func path(_ key: String) throws -> String {
            guard let path = try optionalPath(key) else { throw invalid("\(method) needs \(key)") }
            return path
        }

        func optionalPath(_ key: String) throws -> String? {
            guard let raw = object[key] as? String, !raw.isEmpty else { return nil }
            let expanded = (raw as NSString).expandingTildeInPath
            guard expanded.hasPrefix("/") else { throw invalid("\(method): \(key) must be an absolute path, not \(raw)") }
            return URL(fileURLWithPath: expanded).standardizedFileURL.path
        }

        func tab() throws -> InspectorTab? {
            guard let raw = object["tab"] as? String else { return nil }
            guard let tab = InspectorTab(rawValue: raw) else {
                throw invalid("\(method): tab is one of \(InspectorTab.allCases.map(\.rawValue).joined(separator: ", ")), not \(raw)")
            }
            return tab
        }

        /// A recording folder that exists.
        func folder() throws -> URL {
            let path = try path("folder")
            var isFolder: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isFolder), isFolder.boolValue else {
                throw invalid("\(method): no folder at \(path)")
            }
            return URL(fileURLWithPath: path, isDirectory: true)
        }

        /// The `--snapshot` options as params: `path` (the edit), `library`, `picker`, `shortcuts`, `filter`, `width`,
        /// `height`, `atSeconds`, `tab`, `selectZoom`, `selectClip`, `selectMarker`, `part` and `range` (`{ from, to }`,
        /// `[from, to]` or `"from-to"`, output seconds) and `comment`.
        func snapshotRequest() throws -> RecorderRequest {
            var request = RecorderRequest()
            request.edit = try optionalPath("path") ?? optionalPath("edit")
            request.library = bool("library") ?? false
            request.picker = bool("picker") ?? false
            request.shortcuts = bool("shortcuts") ?? false
            request.filter = object["filter"] as? String
            if let width = number("width") { request.width = CGFloat(width) }
            if let height = number("height") { request.height = CGFloat(height) }
            request.atSeconds = number("atSeconds")
            request.tab = try tab()
            request.selectZoom = int("selectZoom")
            request.selectClip = int("selectClip")
            request.selectMarker = int("selectMarker")
            request.part = try span("part")
            request.range = try span("range")
            request.comment = int("comment")
            guard request.edit != nil || request.library || request.picker else {
                throw invalid("render.snapshot needs path (an edit), library or picker")
            }
            return request
        }

        private func span(_ key: String) throws -> (from: Double, to: Double)? {
            guard let raw = object[key] else { return nil }
            let ends: [Double]
            switch raw {
            case let pair as [String: Any]: ends = [pair["from"], pair["to"]].compactMap { ($0 as? NSNumber)?.doubleValue }
            case let list as [Any]: ends = list.compactMap { ($0 as? NSNumber)?.doubleValue }
            case let text as String: ends = text.split(separator: "-").compactMap { Double($0) }
            default: ends = []
            }
            guard ends.count == 2 else { throw invalid("\(method): \(key) is { from, to } in output seconds") }
            return (ends[0], ends[1])
        }
    }
}

/// The running recorder face: the same calls the `SingleInstance` forward and the live recordings make.
@MainActor
final class LiveRecorderFace: RecorderHostFace {
    func openEditor(path: String, focus: Bool, atSeconds: Double?, tab: InspectorTab?) async throws -> Int {
        try await withCheckedThrowingContinuation { continuation in
            EditorWindows.shared.open(path: path, focus: focus, atSeconds: atSeconds, tab: tab) { result in
                continuation.resume(with: result.map(\.windowNumber))
            }
        }
    }

    func showLibrary(focus: Bool) { LibraryWindow.shared.show(focus: focus) }
    func showPicker() { CapturePicker.shared.show() }
    func openWindows() -> [String: Any] { EditorWindows.shared.openState() }
    func closeEditor(path: String?, window: Int?) throws -> Int? { try EditorWindows.shared.close(path: path, window: window) }
    func startCamera(folder: URL) async -> CameraBubble.StartAnswer { await CameraBubble.shared.start(folder: folder) }
    func stopCamera(folder: URL) -> Bool { CameraBubble.shared.stop(folder: folder) }
}
