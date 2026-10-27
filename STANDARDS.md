# Standards

The judgement calls the check can't enforce, one line each, for the standards-reviewer. What
`mise run check` enforces is never restated here. They are spike-html-apps' Layers and Code calls
that apply to the SDK, and the SDK's own Package calls.

The architecture pages that apply, in the architecture repository:

- `principles/minimal-footprint.md`
- `principles/rolling-currency.md`
- `principles/independent-releases.md`
- `principles/downward-dependencies.md`
- `principles/validation-first.md`

## Package

- The package is `@jaimestill/spike-html-apps-sdk`, one row of spike-html-apps' layer table: the
  SDK's contracts, which spike-html-apps implements, and never an implementation.
- It declares no runtime dependency: the SDK is declarations alone.
- Every export is a `.js` subpath with only a `types` condition.
- `dist/` lives only in a release tag's tree, the pack, never on a branch.
- Releases are `v<version>` annotated tags cut by `release.yml` from `package.json`'s version,
  each with its `CHANGELOG.md` section, and never changed or re-cut.

## Layers

- A layer resolves the layer below only through its release tag, as a consumer does.
- The SDK binds no key and declares no key binding; only the app binds keys.

## Code

- Code meets the bar of spike-html-conventions' `layers/` code at a88828a: a 2–4 line header, a
  one-line doc comment per export, and comments only for a non-obvious why.
- A copied file names its source repository and commit in a provenance line, which reads
  `From|Adapted from <repo> (<commit>): <path>`. It names the immediate source alone; that source
  keeps the earlier lines.
- Handwritten `.d.ts` use `.js` relative specifiers.
- A mise task runs one script or one command, and `check` is a depends list.
