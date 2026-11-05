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
