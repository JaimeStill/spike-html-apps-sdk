# spike-html-apps-sdk

The SDK layer of [spike-html-apps](https://github.com/JaimeStill/spike-html-apps), the
application SDK's contracts: the API client and its Result and Problem types, the auth hook, the
router, and the domain-service pattern. It is type declarations alone, with no runtime and no
dependencies, and is released by git tag; spike-html-apps implements it.

## Install

Each release is a tag, `v<version>`, whose tree is the package as `pnpm pack` builds it:
`package.json`, this README, the LICENSE, and `dist/`. Install it by the tag:

```
npm install --allow-git=root github:JaimeStill/spike-html-apps-sdk#v0.1.0
pnpm add github:JaimeStill/spike-html-apps-sdk#v0.1.0
bun add github:JaimeStill/spike-html-apps-sdk#v0.1.0
```

npm 12 refuses git dependencies unless `--allow-git` allows them; `root` allows the ones the
project itself declares. Each GitHub release also carries the tarball.

## Use

The package is `@jaimestill/spike-html-apps-sdk`. Each subpath is a `.js` name with only a
`types` condition, so it is imported with `import type`, which leaves nothing to load:

```ts
import type { Client, Result } from "@jaimestill/spike-html-apps-sdk/api.js";
import type { Routes } from "@jaimestill/spike-html-apps-sdk/router.js";
```

- `./api.js`: the API client, `Client` and `createClient`, with `Result`, `Problem`, `Page`, and
  their options.
- `./auth.js`: the `TokenProvider` hook and the `anonymous` default.
- `./router.js`: the router, `Router` and `createRouter`, with `Routes`, `Loader`, and `Match`.
- `./service.js`: the domain-service pattern, `Service`, `Endpoint`, and `ServiceFactory`.

## Development

Tasks run through [mise](https://mise.jdx.dev):

```
mise run install    # the pinned tools and node_modules; reads the network
mise run check      # lint, types, build, and the unit tier; reads no network
mise run build      # src/ into dist/
mise run currency   # report every tool, package, and action pin behind its latest
```

A push to main whose `package.json` version has no tag yet releases it: the check, then the pack
committed and tagged, and a GitHub release from `CHANGELOG.md`.

## License

[Apache License 2.0](LICENSE).
