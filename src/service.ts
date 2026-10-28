// The application SDK's domain-service pattern, as types alone, which is all it is: an app's
// domains tier writes each service as a stateless object over a Client, one method per route.
// Adapted from spike-html-packages-sdk (9d10ca6): src/service.d.ts, its declarations made a module.
// test/fixtures/v0.1.0/service.d.ts is that file, which the emitted declaration matches.

import type { Client, Result } from "./api.ts";

/** One route as a method: its arguments (the path params, the body, and an optional signal, by
 * convention last) to the Result of calling it. */
export type Endpoint<A extends unknown[] = never[], T = unknown> = (
  ...args: A
) => Promise<Result<T>>;

/** A domain service: an object of endpoints and nothing else, holding no state between calls. An
 * app's service checks against it with `satisfies Service`. */
export type Service = Readonly<Record<string, Endpoint<never[], unknown>>>;

/** How a service is made: from the client it calls through, so it holds no client of its own. */
export type ServiceFactory<S extends Service> = (client: Client) => S;
