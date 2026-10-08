import AppKit
import Combine
import GenesisKit

struct ModelRoomSweepAxis: Codable {
    var quantityId: String
    var values: [Double]
}

struct ModelRoomSweepConfiguration: Codable {
    var axes: [ModelRoomSweepAxis]
    var outputs: [String]
    var scenarioId: String?
}

struct ModelRoomSweepRun: Codable {
    var inputs: [String: Double]
    var outputs: [String: Double]
}

private struct ModelRoomSweepEvent: Decodable {
    var event: String?
    var total: Int?
    var completed: Int?
    var run: ModelRoomSweepRun?
    var status: String?
    var error: String?
}

@MainActor
final class ModelRoomSweepController: ObservableObject {
    @Published private(set) var runs: [ModelRoomSweepRun] = []
    @Published private(set) var running = false
    @Published private(set) var total = 0
    @Published private(set) var status = "Choose the ranges you want to explore."
    @Published var error: String?
    private let bridge: ToolsBridge
    private var stream: ToolsLineStream?
    private var preparation: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var generation = UUID()
    private var folder: URL?
    private var finalStatus: String?
    private var stopping = false

    init(bridge: ToolsBridge) { self.bridge = bridge }

    deinit {
        preparation?.cancel()
        deadline?.cancel()
        stream?.stop()
        if let folder {
            Task.detached(priority: .utility) {
                do { try FileManager.default.removeItem(at: folder) }
                catch { HubPerf.log("model-room.sweep: closed window input cleanup: \(error)") }
            }
        }
    }

    func start(file: ModelRoomFile, configuration: ModelRoomSweepConfiguration) {
        guard !running else { return }
        var requested = 1
        guard (1...8).contains(configuration.axes.count) else { error = "Choose one to eight input ranges."; return }
        for axis in configuration.axes {
            guard !axis.values.isEmpty && requested <= 10000 / axis.values.count else { error = "Choose at most 10,000 combinations."; return }
            requested *= axis.values.count
        }
        generation = UUID()
        let token = generation
        total = requested
        runs = []
        error = nil
        stopping = false
        finalStatus = nil
        running = true
        status = "Preparing local calculation…"
        preparation = Task { [weak self] in
            guard let self else { return }
            do {
                let created = try await Task.detached(priority: .userInitiated) {
                    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("model-room-sweep-" + UUID().uuidString, isDirectory: true)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    do {
                        try JSONEncoder().encode(file).write(to: directory.appendingPathComponent("model.json"), options: .atomic)
                        try JSONEncoder().encode(configuration).write(to: directory.appendingPathComponent("config.json"), options: .atomic)
                        return directory
                    } catch {
                        do { try FileManager.default.removeItem(at: directory) }
                        catch { HubPerf.log("model-room.sweep: partial input cleanup: \(error)") }
                        throw error
                    }
                }.value
                guard generation == token && !Task.isCancelled else { cleanup(created); return }
                folder = created
                stream = try ToolsLineStream(bridge: bridge, subcommand: "model-room", args: ["sweep", "--input", created.appendingPathComponent("model.json").path, "--config", created.appendingPathComponent("config.json").path, "--stream"], onLines: { [weak self] lines in
                    guard let self, self.generation == token else { return }
                    self.receive(lines)
                }, onExit: { [weak self] exit in
                    guard let self, self.generation == token else { return }
                    self.running = false
                    self.deadline?.cancel()
                    self.stream = nil
                    if let folder = self.folder { self.cleanup(folder); self.folder = nil }
                    if !exit.stopped && exit.status != 0 { self.error = self.error ?? exit.stderr }
                    self.status = self.finalStatus ?? (exit.stopped ? "Cancelled · completed runs retained" : "Calculation ended without a completion receipt")
                })
                deadline = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: 75_000_000_000) }
                    catch { return }
                    guard let self, self.generation == token, self.running else { return }
                    self.stop(message: "Time limit reached · completed runs retained")
                }
            } catch {
                guard generation == token else { return }
                self.error = error.localizedDescription
                running = false
                status = "Could not start the sweep"
                if let folder { cleanup(folder); self.folder = nil }
            }
        }
    }

    func stop(message: String = "Cancelled · completed runs retained") {
        guard running, !stopping else { return }
        stopping = true
        finalStatus = message
        status = "Stopping…"
        preparation?.cancel()
        deadline?.cancel()
        if let stream { stream.stop() }
        else { running = false; status = message }
    }

    private func receive(_ lines: [String]) {
        var batch: [ModelRoomSweepRun] = []
        do {
            for line in lines {
                let event = try JSONDecoder().decode(ModelRoomSweepEvent.self, from: Data(line.utf8))
                if let error = event.error { throw failure(error) }
                switch event.event {
                case "start":
                    guard event.total == total else { throw failure("The sweep returned an unexpected run count.") }
                    status = "Calculating locally…"
                case "run":
                    guard let run = event.run, event.completed == runs.count + batch.count + 1, runs.count + batch.count < total else { throw failure("The sweep returned an out-of-order result.") }
                    batch.append(run)
                case "end":
                    guard event.completed == runs.count + batch.count, event.total == total else { throw failure("The sweep completion count did not match its results.") }
                    switch event.status {
                    case "complete": finalStatus = "Complete · \(total) combinations"
                    case "cancelled": finalStatus = "Cancelled · completed runs retained"
                    case "deadline": finalStatus = "Time limit reached · completed runs retained"
                    default: throw failure("Unknown sweep completion state.")
                    }
                default: throw failure("Unknown sweep event.")
                }
            }
            runs.append(contentsOf: batch)
        } catch {
            runs.append(contentsOf: batch)
            self.error = error.localizedDescription
            stop(message: "Calculation stopped · completed runs retained")
        }
    }

    private func failure(_ message: String) -> NSError {
        NSError(domain: "ModelRoomSweep", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func cleanup(_ url: URL) {
        Task.detached(priority: .utility) {
            do { try FileManager.default.removeItem(at: url) }
            catch { HubPerf.log("model-room.sweep: input cleanup: \(error)") }
        }
    }
}
