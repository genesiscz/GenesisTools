// The wire envelope codec is defined once in the RN-safe contract (`@dd/contract`) so the
// Agent and mobile can never drift. Mobile re-exports it here (never value-imports `lib/*`).
export { decodeEnvelope, encodeEnvelope, type E2eEnvelope } from "@dd/contract";
