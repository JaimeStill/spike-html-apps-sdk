// The application SDK's auth hook: the client asks a TokenProvider for the token each call
// carries. anonymous, the default, is here; an app supplies its own provider.
// Adapted from spike-html-packages-sdk (9d10ca6): src/auth.d.ts, its declarations given a runtime.
// test/fixtures/v0.1.0/auth.d.ts is that file, which the emitted declaration matches.
/** The default provider: no token, and nothing to refresh, so every call goes anonymous. */
// Frozen, since every client that takes the default shares it.
export const anonymous = Object.freeze({
    token: async () => undefined,
    refresh: async () => undefined,
});
