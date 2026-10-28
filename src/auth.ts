// The application SDK's auth hook: the client asks a TokenProvider for the token each call
// carries. anonymous, the default, is here; an app supplies its own provider.
// Adapted from spike-html-packages-sdk (9d10ca6): src/auth.d.ts, its declarations given a runtime.
// test/fixtures/v0.1.0/auth.d.ts is that file, which the emitted declaration matches.

/** Where the client's bearer token comes from. `token` is the current token, undefined when there
 * is none (the call goes without Authorization); `refresh` obtains a new one after a 401, and the
 * client retries that call once with it, or returns the 401's problem when it is undefined. */
export interface TokenProvider {
  token(): Promise<string | undefined>;
  refresh(): Promise<string | undefined>;
}

/** The default provider: no token, and nothing to refresh, so every call goes anonymous. */
// Frozen, since every client that takes the default shares it.
export const anonymous: TokenProvider = Object.freeze({
  token: async () => undefined,
  refresh: async () => undefined,
});
