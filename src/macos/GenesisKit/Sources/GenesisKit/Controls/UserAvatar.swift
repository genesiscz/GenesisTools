import AppKit
import SwiftUI

/// Pictures of people on a host (a PR author, a note's author, a pusher). One fetch per URL for the
/// whole process, off the main thread; the decoded image stays in memory and the HTTP response in
/// URLSession's own cache. A URL that failed once is not asked again in this process: the avatar keeps
/// its fallback.
public final class UserAvatarCache: @unchecked Sendable {
    public static let shared = UserAvatarCache()

    private let lock = NSLock()
    private var images: [String: NSImage] = [:]
    private var failed: Set<String> = []
    private var waiting: [String: [CheckedContinuation<NSImage?, Never>]] = [:]
    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.timeoutIntervalForRequest = 10
        return URLSession(configuration: config)
    }()

    /// The image already in memory; never fetches.
    public func cached(_ url: String) -> NSImage? {
        lock.withLock { images[url] }
    }

    /// The image, fetched once; nil when the URL is not an image or the host refused it.
    public func image(_ url: String) async -> NSImage? {
        enum Next { case hit(NSImage?), wait, fetch }
        let next: Next = lock.withLock {
            if let image = images[url] { return .hit(image) }
            if failed.contains(url) { return .hit(nil) }
            if waiting[url] != nil { return .wait }
            waiting[url] = []
            return .fetch
        }
        switch next {
        case .hit(let image):
            return image
        case .wait:
            return await withCheckedContinuation { continuation in
                let done: NSImage?? = lock.withLock {
                    if let image = images[url] { return .some(image) }
                    if failed.contains(url) { return .some(nil) }
                    waiting[url, default: []].append(continuation)
                    return .none
                }
                if let done { continuation.resume(returning: done) }
            }
        case .fetch:
            let image = await fetch(url)
            let continuations: [CheckedContinuation<NSImage?, Never>] = lock.withLock {
                if let image { images[url] = image } else { failed.insert(url) }
                return waiting.removeValue(forKey: url) ?? []
            }
            for continuation in continuations { continuation.resume(returning: image) }
            return image
        }
    }

    private func fetch(_ string: String) async -> NSImage? {
        guard let url = URL(string: string), url.scheme == "https" || url.scheme == "http" else { return nil }
        let host = url.host ?? ""
        let start = PerfLog.now()
        do {
            let (data, response) = try await session.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            PerfLog.since("avatar.fetch", start)
            guard (200..<300).contains(status), let image = NSImage(data: data), image.isValid else {
                PerfLog.mark("avatar.fetch \(host) answered \(status), \(data.count) bytes: the fallback stays")
                return nil
            }
            return image
        } catch {
            PerfLog.mark("avatar.fetch \(host) failed: \(error.localizedDescription)")
            return nil
        }
    }
}

/// A round picture of a person on a host, with a fallback behind it that shows until the picture
/// loads and stays when it never does: the person's initial on a tint (`.initial`), or a generic
/// person glyph (`.person`).
public struct UserAvatar: View {
    public enum Fallback: Sendable {
        /// The initial of `name` (or `username`) on a tint taken from `username`, unless `tint` is set.
        case initial
        /// The `person.crop.circle.fill` glyph, for a place that shows the name beside it.
        case person
    }

    let url: String?
    let name: String
    let username: String
    let size: CGFloat
    let fallback: Fallback
    let tint: Color?
    @State private var image: NSImage?

    public init(url: String?, name: String = "", username: String = "", size: CGFloat = 22, fallback: Fallback = .initial, tint: Color? = nil) {
        self.url = url
        self.name = name
        self.username = username
        self.size = size
        self.fallback = fallback
        self.tint = tint
    }

    static let tints: [Color] = [
        Color(red: 0.54, green: 0.71, blue: 1), Color(red: 0.98, green: 0.66, blue: 0.25), Color(red: 0.36, green: 0.80, blue: 0.47),
        Color(red: 0.80, green: 0.60, blue: 0.98), Color(red: 0.96, green: 0.50, blue: 0.55), Color(red: 0.40, green: 0.82, blue: 0.85),
    ]

    /// Stable across runs (Swift's `hashValue` is seeded per process), so two people's initials differ.
    public static func tint(for username: String) -> Color {
        let sum = username.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return tints[sum % tints.count]
    }

    public var body: some View {
        ZStack {
            switch fallback {
            case .initial:
                Circle().fill(tint ?? Self.tint(for: username))
                Text(verbatim: String((name.isEmpty ? username : name).prefix(1)).uppercased())
                    .font(.system(size: size * 0.48, weight: .bold))
                    .foregroundColor(Color.black.opacity(0.78))
            case .person:
                Image(systemName: "person.crop.circle.fill")
                    .resizable()
                    .scaledToFit()
                    .foregroundColor(tint ?? Color.white.opacity(0.55))
            }
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFill()
                    .transition(.opacity)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.white.opacity(image == nil && fallback == .person ? 0 : 0.12), lineWidth: 0.5))
        .accessibilityHidden(true)
        .task(id: url) {
            guard let url, !url.isEmpty else {
                image = nil
                return
            }
            if let hit = UserAvatarCache.shared.cached(url) {
                image = hit
                return
            }
            let loaded = await UserAvatarCache.shared.image(url)
            withAnimation(.easeOut(duration: 0.15)) { image = loaded }
        }
    }
}
