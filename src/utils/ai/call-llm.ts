/**
 * The implementation moved to `core/call.ts` in Phase 4, where `ask`'s ChatEngine
 * and the ai-proxy client meet it. This module stays as the import path a dozen
 * youtube and claude call sites already use; the names and signatures are
 * unchanged, so nothing had to be rewritten to follow it.
 */
export type {
    CallLLMOptions,
    CallLLMResult,
    CallLLMStructuredOptions,
    CallLLMStructuredResult,
} from "./core/call";
export { callLLM, callLLMStructured, streamLLM } from "./core/call";
