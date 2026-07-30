import type { LocalModelDescriptor, LocalRuntimeId } from "../descriptors/types";
import type { OnnxDevice } from "../device";

/** A model the runtime has loaded and holds open. */
export interface LoadedLocalModel {
    run(input: unknown, options?: Record<string, unknown>): Promise<unknown>;
    dispose(): void | Promise<void>;
}

/**
 * How inference executes for one backend. Runtimes own their process-level
 * resources (loaded pipelines, native handles) and must be disposed.
 */
export interface LocalRuntime {
    readonly id: LocalRuntimeId;
    supports(descriptor: LocalModelDescriptor): boolean;
    load(descriptor: LocalModelDescriptor, device?: OnnxDevice): Promise<LoadedLocalModel>;
    dispose(): void;
}
