// The default token provider as a consumer imports it: the package's ./auth.js export, which
// resolves to the dist/ mise run build wrote.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { anonymous } from "@jaimestill/spike-html-apps-sdk/auth.js";

describe("anonymous", () => {
  test("gives no token", async () => {
    assert.equal(await anonymous.token(), undefined);
  });

  test("never refreshes: a refresh gives no token either", async () => {
    assert.equal(await anonymous.refresh(), undefined);
    assert.equal(await anonymous.token(), undefined);
  });

  test("is frozen, since every client that takes the default shares it", () => {
    assert.ok(Object.isFrozen(anonymous));
  });
});
