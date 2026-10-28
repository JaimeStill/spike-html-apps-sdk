// The application SDK's auth hook, declared: the client asks a TokenProvider for the token each
// call carries. spike-html-apps implements the default; an app supplies its own provider.
// From spike-html-packages-sdk (9d10ca6): src/auth.d.ts.

/** Where the client's bearer token comes from. `token` is the current token, undefined when there
 * is none (the call goes without Authorization); `refresh` obtains a new one after a 401, and the
 * client retries that call once with it, or returns the 401's problem when it is undefined. */
export interface TokenProvider {
  token(): Promise<string | undefined>;
  refresh(): Promise<string | undefined>;
}

/** The default provider: no token, and nothing to refresh, so every call goes anonymous. */
export declare const anonymous: TokenProvider;
