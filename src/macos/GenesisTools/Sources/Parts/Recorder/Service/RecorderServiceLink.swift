import Foundation

/// What an editor's edit session needs of the connection to the recorder service. The recorder host is the real
/// one (`RecorderServiceHost`); a test answers the calls itself, so it can check the ops a window action sends.
@MainActor
protocol RecorderServiceLink: AnyObject {
    var isConnected: Bool { get }
    /// The methods the service listed in its hello.
    var serviceMethods: [String] { get }
    @discardableResult
    func call(_ method: String, params: [String: Any], timeout: TimeInterval,
              onProgress: ((LiveRecordingRPCClient.CallProgress) -> Void)?,
              completion: @escaping (Result<Any?, Error>) -> Void) -> Int?
    func listen(_ owner: AnyObject, notification: @escaping (String, Any?) -> Void, connected: @escaping () -> Void)
    func unlisten(_ owner: AnyObject)
}

extension RecorderServiceHost: RecorderServiceLink {}

/// Library commands share the host's hello and connection; tests substitute the link and CLI runner.
@MainActor
final class RecorderCommands {
    var link: () -> RecorderServiceLink? = { RecorderServiceHost.shared }
    var runTools: (_ argv: [String], _ done: @escaping @MainActor (Int32, String, String) -> Void) -> Void = {
        ToolsRunner.run($0, done: $1)
    }

    func run(_ method: String, params: [String: Any], argv: [String], json: Bool = false,
             timeout: TimeInterval = 120, done: @escaping (Result<Any?, EditorModel.ApplyFailure>) -> Void) {
        if let service = link(), service.isConnected, service.serviceMethods.contains(method) {
            service.call(method, params: params, timeout: timeout, onProgress: nil) { result in
                done(result.mapError { EditorModel.ApplyFailure(reason: EditorSession.reason($0)) })
            }
            return
        }
        runTools(argv) { status, stdout, stderr in
            guard status == 0 else {
                done(.failure(EditorModel.ApplyFailure(reason: stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)")))
                return
            }
            if json {
                do { done(.success(try JSONSerialization.jsonObject(with: Data(stdout.utf8)))) }
                catch { done(.failure(EditorModel.ApplyFailure(reason: "the answer is not JSON"))) }
            } else {
                done(.success(nil))
            }
        }
    }
}
