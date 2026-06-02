// Frozen E2E test vectors — REAL, internally-consistent X25519 keypairs + a fixed nonce,
// so the Agent and the mobile codecs are byte-identical (both import this exact module via
// the `@dd/` alias). The mobile `box-cipher.test.ts` (plan 04+) asserts its `seal` output
// equals `ciphertextBase64` — that cross-endpoint equality is the proof the managed tier
// rests on. A `.ts` const (not `.json`) avoids needing `resolveJsonModule` under the repo's
// `verbatimModuleSyntax` tsconfig. NEVER use these keys in production — they are public.

export const E2E_TEST_VECTORS = {
    alicePublicKey: "65LIAWJucA9o3XSgVr7z3qOlrjNg22zJ8yKrw2+v0mQ=",
    alicePrivateKey: "7Ljzjt/XkH8LpuURrmEJyG83wZ0fPoVd32cJ7hig4Iw=",
    bobPublicKey: "h/lmzsfsW3618PGdhFLKmFVKOS3xyELiObhxCAZiPls=",
    bobPrivateKey: "IKszD25KvFobKqhPsNeK1vYgqw3PQgc8uIQfJqWZY3k=",
    nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX",
    plaintext: '{"path":"/api/system/pulse","method":"GET"}',
    ciphertextBase64: "0rQ1UN/PhP2FfEFpRCl+hxTJ5vF6Rm9fuwvHZqMQTrJwdPb1DCWR73jKOD+uKg90uxR4bNcfy7woU+M=",
} as const;
