import Foundation

/// One `tools agents blame` per repository at a time, for every file that asked since the last one. Each open note used
/// to start its own blame (and its own `git rev-parse`) whenever its repository refreshed: Genesis Markdown with a day
/// of open notes started 51 to 66 at once, each a full GenesisTools launch, so launchservicesd ran at 69-159% and the
/// load average sat at 380-580 (2026-10-24 19:26, about 9,300 blame launches an hour).
@MainActor
final class AgentBlameQueue {
    static let shared = AgentBlameQueue()

    struct Request {
        weak var model: AgentBlameModel?
        let ticket: Int
        let url: URL
    }

    /// Requests that arrive within this long of the first one share its run.
    var delay: Duration = .milliseconds(300)
    /// The least time from one run of a repository to its next. A vault that agents write to changes every few seconds,
    /// and each run is a GenesisTools launch that Launch Services checks in.
    var minInterval: Duration = .seconds(5)
    /// Monotonic time and delayed work are replaceable so tests can advance the cooldown without sleeping.
    var now: () -> ContinuousClock.Instant = { .now }
    var later: (Duration, @escaping @MainActor () -> Void) -> Void = { delay, start in
        Task { @MainActor in
            try? await Task.sleep(for: delay)
            start()
        }
    }
    var provider: () -> GenesisKitGTProvider = { GenesisKitGT.provider }
    /// Runs one blame off the main thread; tests replace it.
    var run: @Sendable (GenesisKitGTProvider, String, [String]) -> AgentBlameResult? = { provider, repo, paths in
        try? provider.agentBlame(repo: repo, paths: paths)
    }
    /// How many blame runs started, for the tests and the log.
    private(set) var runs = 0

    private var waiting: [String: [String: [Request]]] = [:]
    private var running: Set<String> = []
    private var scheduled: Set<String> = []
    private var lastStart: [String: ContinuousClock.Instant] = [:]
    /// A folder's repository root, found once: every note of a folder used to run its own `git rev-parse`.
    private var roots: [String: URL] = [:]
    private var resolving: [String: [Request]] = [:]

    init() {}

    func request(_ request: Request) {
        let folder = request.url.deletingLastPathComponent()
        let key = folder.standardizedFileURL.path
        if let root = roots[key] {
            enqueue(request, root: root)
            return
        }
        guard resolving[key] == nil else {
            resolving[key]?.append(request)
            return
        }
        resolving[key] = [request]
        let provider = provider()
        DispatchQueue.global(qos: .utility).async {
            let root = GitQueries(provider: provider).root(of: folder)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let requests = self.resolving.removeValue(forKey: key) ?? []
                guard let root else { return }
                self.roots[key] = root
                for request in requests { self.enqueue(request, root: root) }
            }
        }
    }

    /// Tells the queue a folder's repository root, as a lookup would (tests).
    func remember(root: URL, for folder: URL) {
        roots[folder.standardizedFileURL.path] = root
    }

    private func enqueue(_ request: Request, root: URL) {
        guard let path = GitQueries.relative(request.url, to: root) else { return }
        waiting[root.path, default: [:]][path, default: []].append(request)
        schedule(root.path)
    }

    private func schedule(_ repo: String) {
        guard !running.contains(repo), scheduled.insert(repo).inserted else { return }
        var wait = delay
        if let last = lastStart[repo] { wait = max(wait, last + minInterval - now()) }
        later(wait) { [weak self] in self?.start(repo) }
    }

    private func start(_ repo: String) {
        scheduled.remove(repo)
        guard let batch = waiting.removeValue(forKey: repo), !batch.isEmpty else { return }
        running.insert(repo)
        lastStart[repo] = now()
        runs += 1
        let paths = batch.keys.sorted()
        let provider = provider()
        let run = run
        DispatchQueue.global(qos: .utility).async {
            let result = run(provider, repo, paths)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.running.remove(repo)
                if let result {
                    for (path, requests) in batch {
                        for request in requests { request.model?.apply(result, path: path, ticket: request.ticket, url: request.url) }
                    }
                }
                if self.waiting[repo] != nil { self.schedule(repo) }
            }
        }
    }
}
