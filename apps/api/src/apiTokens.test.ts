import assert from "node:assert/strict";
import test from "node:test";
import { verifyApiTokenValue } from "./apiTokens.js";

test("verifyApiTokenValue accepts the legacy environment token with all scopes", async () => {
  const previous = process.env.CRON_MASTER_API_KEY;
  process.env.CRON_MASTER_API_KEY = "unit-secret";

  try {
    const result = await verifyApiTokenValue("unit-secret", ["jobs:write", "deadman:write"]);

    assert.equal(result.ok, true);
    assert.equal(result.token?.legacy, true);
    assert.deepEqual(result.token?.scopes, ["*"]);
  } finally {
    if (previous === undefined) delete process.env.CRON_MASTER_API_KEY;
    else process.env.CRON_MASTER_API_KEY = previous;
  }
});

test("verifyApiTokenValue rejects missing tokens before database lookup", async () => {
  const previous = process.env.CRON_MASTER_API_KEY;
  delete process.env.CRON_MASTER_API_KEY;

  try {
    const result = await verifyApiTokenValue("", ["jobs:read"]);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing");
  } finally {
    if (previous !== undefined) process.env.CRON_MASTER_API_KEY = previous;
  }
});
