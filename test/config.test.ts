import test from "node:test";
import assert from "node:assert/strict";

import { slugify } from "../src/core/config.js";

test("slugify normalizes profile names", () => {
  assert.equal(slugify(" Copilot Loke 60000 "), "copilot-loke-60000");
  assert.equal(slugify("###"), "");
});
