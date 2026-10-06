import Foundation

struct BugToTestFingerprint: Codable, Equatable {
    var tag: String
    var role: String
    var name: String
}
struct BugToTestLocator: Codable, Equatable {
    var kind: String
    var value: String
    var name: String?
    var fingerprint: BugToTestFingerprint?
    var label: String { kind == "role" ? value + " “" + (name ?? "") + "”" : kind + ": " + value }
}
struct BugToTestAction: Codable, Identifiable, Equatable {
    var id: String
    var kind: String
    var locator: BugToTestLocator?
    var value: String?
    var url: String?
    var sourceUrl: String?
    var excluded: Bool
    var at: Double
    var label: String { kind + " · " + (locator?.label ?? url ?? "") }
}
struct BugToTestEvidence: Codable, Identifiable, Equatable {
    var id: String
    var kind: String
    var text: String
    var excluded: Bool
    var at: Double
}
struct BugToTestExpectation: Codable, Equatable {
    var description: String
    var kind: String
    var locator: BugToTestLocator?
    var expected: String
    var valid: Bool {
        guard !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !expected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              ["text", "value", "visible", "url"].contains(kind) else { return false }
        if kind == "visible" && !["true", "false"].contains(expected) { return false }
        if kind != "url" && (locator?.value.isEmpty != false) { return false }
        if kind == "url" && URL(string: expected)?.scheme.map({ ["http", "https"].contains($0) }) != true { return false }
        return true
    }
}
struct BugToTestRecording: Codable, Equatable {
    var version: Int
    var id: String
    var title: String
    var initialUrl: String
    var actions: [BugToTestAction]
    var evidence: [BugToTestEvidence]
    var expectation: BugToTestExpectation?
    var workspace: String?
    var removedActionIds: [String]?
    var triggerActionId: String?
    var validForGeneration: Bool { version == 1 && expectation?.valid == true && URL(string: initialUrl)?.scheme.map { ["http", "https"].contains($0) } == true }
}
struct BugToTestBrowser: Decodable, Identifiable {
    var id: String
    var name: String
}
struct BugToTestOpenedBrowser: Decodable {
    var browserId: String
    var pid: Int
    var port: Int
    var userDataDir: String
}
struct BugToTestTab: Decodable, Identifiable {
    var port: Int
    var id: String
    var title: String
    var url: String
}
struct BugToTestResult: Codable, Equatable {
    var status: String
    var message: String
    var testHash: String
    var trace: String?
    var report: String
    var durationMs: Double
    var exitCode: Int
    var label: String {
        switch status {
        case "intended-failure": return "Bug reproduced"
        case "passed": return "Assertion passed"
        case "cancelled": return "Cancelled"
        case "timed-out": return "Execution timed out"
        default: return "Setup or selector failed"
        }
    }
}
struct BugToTestGeneration: Decodable {
    var directory: String
    var recording: BugToTestRecording
}
struct BugToTestMinimized: Decodable {
    var directory: String
    var recording: BugToTestRecording
    var result: BugToTestResult
}
func bugToTestError(_ message: String) -> NSError { NSError(domain: "BugToTest", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
