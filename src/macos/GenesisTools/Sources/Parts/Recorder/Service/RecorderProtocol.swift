import Foundation

/// The recorder service's answers and notifications as the editor reads them, the shapes of
/// src/recorder/lib/service-protocol.ts. `RecorderProtocolTests` decodes every example of
/// `src/recorder/lib/__fixtures__/service-protocol.json` with them.
enum RecorderProtocol {
    struct HelloAnswer: Decodable, Equatable {
        let protocolVersion: Int
        let methods: [String]
        let version: String

        enum CodingKeys: String, CodingKey {
            case protocolVersion = "protocol"
            case methods, version
        }
    }

    /// `session.open`: the edit as the service holds it.
    struct OpenedSession: Decodable {
        let path: String
        let project: EditProject
        let revision: Int
        /// The undo steps the edit keeps; absent from a service older than 2026-11-06.
        let undoDepth: Int?
    }

    /// `edit.apply`, `edit.undo`, `edit.redo` and `gesture.commit`.
    struct EditAnswer: Decodable {
        let revision: Int
        let project: EditProject
        let warnings: [String]?
        /// `removeIdle`: the source ranges it took out or sped up, in microseconds.
        let removedIdleUs: [[Int64]]?
        /// `normalize`: what it measured and the volume it set.
        let loudness: Loudness?
        /// `edit.undo`: the ops it took back; `edit.redo`: the ops it made again.
        let undone: [String]?
        let redone: [String]?
    }

    struct Loudness: Decodable, Equatable {
        let measuredLufs: Double?
        let volume: Double
    }

    /// `gesture.begin`, `gesture.preview` and `gesture.cancel`; a preview that a newer one replaced says `superseded`.
    struct GestureAnswer: Decodable {
        let project: EditProject
        let revision: Int?
        let superseded: Bool?
    }

    /// The service's notification after each change of an edit it holds; `by` names the writer.
    struct ProjectChanged: Decodable, Equatable {
        let path: String
        let revision: Int
        let by: String
        /// "undo" or "redo" when the change took one back or made it again; nil for an edit (and from an older service).
        var action: String?
    }

    struct WindowRow: Codable, Equatable {
        let path: String
        let title: String
        let window: Int
    }

    /// `window.list`'s answer and the host's `window.changed`.
    struct WindowState: Codable, Equatable {
        let front: WindowRow?
        let open: [WindowRow]
    }

    /// A JSON value from the RPC client (`JSONSerialization` objects) as a Decodable type.
    static func decode<T: Decodable>(_ type: T.Type, from value: Any?) throws -> T {
        guard let value, JSONSerialization.isValidJSONObject(value) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "the answer is not a JSON object"))
        }
        return try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
}
