# Changelog

All notable changes to `@jaimestill/spike-html-apps-sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-28

### Added

- The runtime: the declarations are now TypeScript modules, built to ES modules with their
  declarations, with no runtime dependency.
- `./api.js`: `createClient`'s runtime on fetch, every call resolving to a `Result`, with a
  bearer token from the `TokenProvider` and one shared refresh on a 401; `stream`, a
  text/event-stream response's events as `ServerSentEvent`s, and `StreamError`; and `upload`, a
  body sent over XMLHttpRequest with its progress, and `UploadOptions`.
- `./auth.js`: `anonymous`'s runtime, the provider with no token.
- `./router.js`: `createRouter`'s runtime on the Navigation API and URLPattern; the `error`
  option, the element a failed route mounts; and the `change` event.
- `./events.js`: the event sequence, `EventSequence`, `CloudEvent`, `Cursor`, `Delivery`, and
  `ReadOptions`.
- `./events/nats.js`: `natsSequence`, an event sequence over a JetStream stream read over NATS's
  WebSocket transport, on the optional peer dependencies `@nats-io/nats-core` and
  `@nats-io/jetstream` `^3.4.0`, needed only for this subpath.

### Changed

- Breaking: the router's `start()` and `query()` return `Promise<void>`: `start()` resolves on
  the first mount and rejects when its route fails, and `query()` once `current.query` is
  updated.
- Breaking: the router's base, without the `base` option, is the document's `<base href>` before
  it falls back to `/`.
- Breaking: `Client` gains the required members `stream` and `upload`, so code that implements
  `Client`, an app's fake among it, must add them.
- `Problem` keeps every extension member the problem document carries.
- `ClientProblemType` gains `urn:standards-lab:problem:decode`, the problem of a 2xx body that
  doesn't decode as its content type claims, or of a stream's 2xx response that isn't
  text/event-stream, which carries the response's status; and `urn:standards-lab:problem:encode`,
  the problem of a request body JSON.stringify throws on or gives nothing for, status 0 and nothing
  sent, which was the network problem before.
- A call's `RequestOptions` gain `query`, its query parameters, and `headers`, added to its
  request.
- `exports` lists the six public subpaths by name, each with a `types` and a `default` condition,
  in place of the `./*.js` pattern; the internal event-stream parser isn't exported.

## [0.1.0] - 2026-10-27

### Added

- The SDK layer, first released under this name: copied from spike-html-packages-sdk v0.1.0
  (9d10ca6), the API client, auth, router, and domain-service declarations, types only.
- The release by tag: `v<version>`, whose tree is the pack, with the tarball on its GitHub
  release.

[Unreleased]: https://github.com/JaimeStill/spike-html-apps-sdk/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/JaimeStill/spike-html-apps-sdk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/JaimeStill/spike-html-apps-sdk/releases/tag/v0.1.0
