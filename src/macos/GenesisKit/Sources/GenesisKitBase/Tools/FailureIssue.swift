import Foundation

/// The issue a failure is filed as, from the error reply of the process that failed (`rpcErrorBody` in
/// src/utils/rpc/errors.ts): the tool whose process answered (`meetings`, filled by that process, never typed at a
/// throw) and the short title the place that threw gave. The drafted title is `[<tool>] <title>`.
public struct FailureIssue: Codable, Equatable, Sendable {
    public var tool: String
    public var title: String?

    public init(tool: String, title: String? = nil) {
        self.tool = tool
        self.title = title
    }

    /// The `issue` member of a JSON-RPC error; nil when there is none or it names no tool.
    public init?(json: Any?) {
        guard let object = json as? [String: Any], let tool = object["tool"] as? String, !tool.isEmpty else { return nil }
        let title = (object["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.init(tool: tool, title: title?.isEmpty == false ? title : nil)
    }
}
