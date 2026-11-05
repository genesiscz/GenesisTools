import Foundation
import XCTest
@testable import GenesisToolsRecorder

/// A recorder service in a test, answering at once on the main thread: it records every call and holds one edit,
/// which `rules` changes for each op (a test names only the ops it sends; the real rules are the TypeScript ones, which
/// the golden fixtures check). The undo stack and the gestures work as the service's do.
@MainActor
final class FakeServiceLink: RecorderServiceLink {
    typealias Rules = (_ project: EditProject, _ op: [String: Any]) throws -> EditProject

    struct Refusal: Error {}

    var isConnected = true
    var serviceMethods = ["session.open", "session.close", "edit.apply", "edit.undo", "edit.redo", "gesture.begin",
                          "gesture.preview", "gesture.commit", "gesture.cancel"]
    private(set) var project: EditProject
    private(set) var calls: [(method: String, params: [String: Any])] = []
    var rules: Rules
    /// The answer of a `movie.<name>` call.
    var movieAnswer: (String, [String: Any]) -> Any? = { _, _ in [String: Any]() }
    private var revision = 1
    private var undo: [EditProject] = []
    private var redo: [EditProject] = []
    private var marks: [String: EditProject] = [:]
    private var drafts: [String: EditProject] = [:]
    /// While true the answers wait for `deliver()`, as a real service's answers come a moment later (in order).
    var holdAnswers = false
    private var held: [() -> Void] = []

    init(project: EditProject, rules: @escaping Rules = { project, _ in project }) {
        self.project = project
        self.rules = rules
    }

    /// The ops of every `edit.apply` and `gesture.commit`'s last preview, in order, as JSON objects.
    var sentOps: [[String: Any]] {
        var previews: [String: [[String: Any]]] = [:]
        var sent: [[String: Any]] = []
        for call in calls {
            let ops = call.params["ops"] as? [[String: Any]] ?? []
            switch call.method {
            case "edit.apply": sent += ops
            case "gesture.preview": previews[call.params["gesture"] as? String ?? ""] = ops
            case "gesture.commit": sent += previews[call.params["gesture"] as? String ?? ""] ?? []
            default: break
            }
        }
        return sent
    }

    var sentTags: [String] { sentOps.compactMap { $0["op"] as? String } }

    func count(_ method: String) -> Int { calls.filter { $0.method == method }.count }

    @discardableResult
    func call(_ method: String, params: [String: Any], timeout: TimeInterval,
              onProgress: ((LiveRecordingRPCClient.CallProgress) -> Void)?,
              completion: @escaping (Result<Any?, Error>) -> Void) -> Int? {
        calls.append((method, params))
        let result: Result<Any?, Error>
        do {
            result = .success(try answer(method, params))
        } catch let failure as LiveRecordingRPCClient.Failure {
            result = .failure(failure)
        } catch {
            result = .failure(LiveRecordingRPCClient.Failure.remote(code: -32603, message: "\(error)"))
        }
        if holdAnswers {
            held.append { completion(result) }
        } else {
            completion(result)
        }
        return calls.count
    }

    /// Delivers the held answers in the order of their calls.
    func deliver() {
        while !held.isEmpty { held.removeFirst()() }
    }

    func listen(_ owner: AnyObject, notification: @escaping (String, Any?) -> Void, connected: @escaping () -> Void) {}

    func unlisten(_ owner: AnyObject) {}

    private func answer(_ method: String, _ params: [String: Any]) throws -> Any? {
        let gesture = params["gesture"] as? String ?? ""
        switch method {
        case "session.open": return ["path": params["path"] ?? "", "project": try json(project), "revision": revision]
        case "session.close": return ["closed": true]
        case "edit.apply":
            let next = try apply(params["ops"] as? [[String: Any]] ?? [], to: project)
            return try change(to: next)
        case "edit.undo":
            guard let previous = undo.popLast() else { throw LiveRecordingRPCClient.Failure.remote(code: 1017, message: "nothing to undo") }
            redo.append(project)
            project = previous
            revision += 1
            return try edited(["undone": ["op"]])
        case "edit.redo":
            guard let next = redo.popLast() else { throw LiveRecordingRPCClient.Failure.remote(code: 1017, message: "nothing to redo") }
            undo.append(project)
            project = next
            revision += 1
            return try edited(["redone": ["op"]])
        case "gesture.begin":
            marks[gesture] = project
            return ["project": try json(project), "revision": revision]
        case "gesture.preview":
            let draft = try apply(params["ops"] as? [[String: Any]] ?? [], to: marks[gesture] ?? project)
            drafts[gesture] = draft
            return ["project": try json(draft)]
        case "gesture.commit":
            let draft = drafts.removeValue(forKey: gesture) ?? project
            marks[gesture] = nil
            return try change(to: draft)
        case "gesture.cancel":
            marks[gesture] = nil
            drafts[gesture] = nil
            return ["project": try json(project), "revision": revision]
        case let name where name.hasPrefix("movie."):
            return movieAnswer(String(name.dropFirst("movie.".count)), params)
        default:
            throw LiveRecordingRPCClient.Failure.remote(code: -32601, message: "unknown method \(method)")
        }
    }

    private func apply(_ ops: [[String: Any]], to start: EditProject) throws -> EditProject {
        try ops.reduce(start) { try rules($0, $1) }
    }

    private func change(to next: EditProject) throws -> Any? {
        if next != project {
            undo.append(project)
            redo.removeAll()
            project = next
            revision += 1
            project.revision = revision
        }
        return try edited([:])
    }

    private func edited(_ extra: [String: Any]) throws -> Any? {
        project.revision = revision
        return (["revision": revision, "project": try json(project)] as [String: Any]).merging(extra) { $1 }
    }

    private func json(_ project: EditProject) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(project))
    }
}

/// Stand-ins for the TypeScript rules of the ops the window tests send: enough to draw what an op adds, moves or
/// removes. The real rules, with their limits and defaults, are tested in TypeScript (recording-editor.test.ts), and the
/// golden fixtures check that both sides read the same ops and edits.
enum FakeRules {
    static func basic(_ project: EditProject, _ op: [String: Any]) throws -> EditProject {
        var next = project
        let id = op["id"] as? String
        let lane = op["lane"] as? String
        switch op["op"] as? String {
        case "zoom":
            next.zooms.append(EditProject.Zoom(id: "z\(next.zooms.count + 1)", startUs: us(op["from"]), endUs: us(op["to"]), lane: lane))
            next.zooms.sort { $0.startUs < $1.startUs }
        case "unzoom":
            next.zooms.removeAll { $0.id == id }
        case "redact", "spotlight":
            let rect = op["rect"] as? [String: Double] ?? [:]
            var list = next.redactions ?? []
            list.append(EditProject.Redaction(id: "r\(list.count + 1)", startUs: us(op["from"]), endUs: us(op["to"]),
                                              x: rect["x"] ?? 0.4, y: rect["y"] ?? 0.4, width: rect["width"] ?? 0.2,
                                              height: rect["height"] ?? 0.2,
                                              style: op["op"] as? String == "spotlight" ? .spotlight : .blur, lane: lane))
            next.redactions = list
        case "unredact":
            next.redactions = next.redactions?.filter { $0.id != id }
            if next.redactions?.isEmpty == true { next.redactions = nil }
        case "addLane":
            let kinds = try (op["kinds"] as? [String]).map { try JSONDecoder().decode([EffectKind].self, from: JSONSerialization.data(withJSONObject: $0)) }
            let lanes = next.lanes ?? EffectLanes.defaults
            next.lanes = lanes + [EffectLane(id: "lane\(lanes.count + 1)", kinds: kinds)]
        case "camera":
            if op["enabled"] as? Bool == false {
                next.camera = nil
                break
            }
            var camera = try XCTUnwrap(next.camera)
            if let x = op["x"] as? Double { camera.x = x }
            if let y = op["y"] as? Double { camera.y = y }
            if op["x"] != nil || op["y"] != nil { camera.corner = .custom }
            if let corner = (op["corner"] as? String).flatMap(EditProject.CameraCorner.init(rawValue:)) { camera.corner = corner }
            if let size = op["size"] as? Double { camera.size = size }
            next.camera = camera
        default:
            throw FakeServiceLink.Refusal()
        }
        return next
    }

    static func us(_ seconds: Any?) -> Int64 { Int64((((seconds as? Double) ?? 0) * 1_000_000).rounded()) }
}

extension EditorModel {
    /// A model whose edit lives on `service`; a `tools` process would fail the test (the window starts none online).
    static func on(_ service: FakeServiceLink, store: ProjectStore) -> EditorModel {
        let model = EditorModel(project: service.project, store: store, link: { service })
        model.runTools = { argv, done in
            XCTFail("the window ran tools \(argv.joined(separator: " ")) while the service answers")
            done(1, "", "no tools in this test\n")
        }
        return model
    }
}
