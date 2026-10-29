# spike-html-apps-sdk

The SDK layer of [spike-html-apps](https://github.com/JaimeStill/spike-html-apps), the
application SDK: the API client and its Result and Problem types, the auth hook, the router, the
domain-service pattern, and the event sequence with its NATS adapter. It is a runtime with no
runtime dependency, written in TypeScript and shipped as ES modules with their declarations, and
is released by git tag.

## Install

Each release is a tag, `v<version>`, whose tree is the package as `pnpm pack` builds it:
`package.json`, this README, the LICENSE, and `dist/`. Install it by the tag:

```
npm install --allow-git=root github:JaimeStill/spike-html-apps-sdk#v0.2.0
pnpm add github:JaimeStill/spike-html-apps-sdk#v0.2.0
bun add github:JaimeStill/spike-html-apps-sdk#v0.2.0
```

npm 12 refuses git dependencies unless `--allow-git` allows them; `root` allows the ones the
project itself declares. Each GitHub release also carries the tarball.

## Use

The package is `@jaimestill/spike-html-apps-sdk`. It exports the six subpaths below, each a `.js`
name with a `types` and a `default` condition; its internal modules, such as the event-stream
parser, aren't importable:

```ts
import { createClient } from "@jaimestill/spike-html-apps-sdk/api.js";
import { createRouter } from "@jaimestill/spike-html-apps-sdk/router.js";
import type { Service } from "@jaimestill/spike-html-apps-sdk/service.js";
```

- `./api.js`: the API client, `createClient` and `Client`. Its calls (`get`, `post`, `put`,
  `patch`, `delete`) take a request's `query`, `headers`, and `signal`, and resolve to a `Result`
  and never reject: the decoded data, or an RFC 9457 `Problem` with every extension member the
  server sent, or one the client made itself (`ClientProblemType`: network, abort, timeout,
  decode, and encode). `stream` reads a text/event-stream response's `ServerSentEvent`s; `upload`
  sends a body over XMLHttpRequest and reports its progress. A `TokenProvider` puts a bearer token
  on each request and is asked once to refresh on a 401. `Page` is a page of a list.
- `./auth.js`: the `TokenProvider` hook and the `anonymous` default, which sends no token.
- `./router.js`: the router, `createRouter` and `Router`, with `Routes`, `Loader`, and `Match`. It
  mounts each route's element in its outlet, loading its module on the first visit, and the
  `error` option's element when a route fails; it dispatches `change`, and `start()` and `query()`
  return promises. Its base is the `base` option, else the document's `<base href>`, else `/`.
- `./service.js`: the domain-service pattern, `Service`, `Endpoint`, and `ServiceFactory`, as
  types: an app's domains tier writes each service as a stateless object over a `Client`, checked
  with `satisfies Service`.
- `./events.js`: the event sequence, `EventSequence`, read as `Delivery`s of `CloudEvent`s from an
  opaque `Cursor`, as types.
- `./events/nats.js`: `natsSequence`, an `EventSequence` over a JetStream stream, read over NATS's
  WebSocket transport.

`./events/nats.js` imports `@nats-io/nats-core` and `@nats-io/jetstream` (`^3.4.0`), the package's
optional peer dependencies: install them only to use that subpath. No other subpath imports them.

The runtime targets the browser. The router needs the Navigation API and `URLPattern`. `upload`
needs `XMLHttpRequest`; where there is none, as on Node, it resolves to the network problem.

## Development

Tasks run through [mise](https://mise.jdx.dev):

```
mise run install    # the pinned tools and node_modules; reads the network
mise run check      # lint, types, build, and both test tiers; reads no network
mise run build      # src/ into dist/
mise run currency   # report every tool, package, and action pin behind its latest
```

The check runs two test tiers on the build. The unit tier runs under `node --test`: the client
against a loopback server, the event-stream parser, the emitted declarations against v0.1.0's,
the layer's import rules, a pack of the build and its brotli budget, the event-sequence contract,
and the NATS adapter against the pinned `nats-server`, which the tier starts itself. The browser
tier runs the router and the upload in the pinned `chrome-headless-shell`. `mise run install`
installs both pins.

A push to main whose `package.json` version has no tag yet releases it: the check, then the pack
committed and tagged, and a GitHub release from `CHANGELOG.md`.

## Provenance

The layer is copied from spike-html-packages-sdk at 9d10ca6, its v0.1.0. Each copied file that
takes comments names its source in a provenance line; the JSON files, which take none, carry no
line.

## License

[Apache License 2.0](LICENSE).
