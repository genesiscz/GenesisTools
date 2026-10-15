//
//  RenderProbeWatch.swift
//
//  The invalidation side of `RenderProbe`: `watch(model, "name")` counts every `objectWillChange` of a model as
//  `publish.name`, so a render's ` bodies[...]` summary also says which model fired. A body that ran with no
//  publish of its own was re-run by its parent (a closure argument or an observed object it only hands on).
//  Off (the default), nothing subscribes.
//

import Combine

public extension RenderProbe {
    /// Counts `object`'s publishes as `publish.<name>` while the probe is on; keep the result as long as you watch.
    static func watch<O: ObservableObject>(_ object: O, _ name: String) -> AnyCancellable? {
        guard enabled else { return nil }
        return object.objectWillChange.sink { _ in hit("publish." + name) }
    }
}
