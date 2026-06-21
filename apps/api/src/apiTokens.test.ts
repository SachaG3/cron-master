import assert from "node:assert/strict";
import test from "node:test";
import { publicApiProbeTargets, publicApiScopes, testApiToken, verifyApiTokenValue } from "./apiTokens.js";

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

test("publicApiScopes exposes read/write dead-man permissions separately", () => {
  assert.ok(publicApiScopes.includes("deadman:read"));
  assert.ok(publicApiScopes.includes("deadman:write"));
});

test("publicApiProbeTargets separates live-safe checks from write checks", () => {
  const writeProbe = publicApiProbeTargets.find((probe) => probe.id === "jobs-write");
  const liveProbe = publicApiProbeTargets.find((probe) => probe.id === "status");

  assert.deepEqual(writeProbe?.requiredScopes, ["jobs:write"]);
  assert.equal(writeProbe?.liveSafe, false);
  assert.equal(writeProbe?.destructive, true);
  assert.deepEqual(liveProbe?.requiredScopes, ["status:read"]);
  assert.equal(liveProbe?.liveSafe, true);
});

test("testApiToken returns probe results for requested scopes", async () => {
  const previous = process.env.CRON_MASTER_API_KEY;
  process.env.CRON_MASTER_API_KEY = "unit-secret";

  try {
    const result = await testApiToken({ token: "unit-secret", scopes: ["status:read", "deadman:read"] });

    assert.equal(result.ok, true);
    assert.equal(result.reason, "ok");
    assert.deepEqual(result.requestedScopes, ["status:read", "deadman:read"]);
    assert.ok(result.probes.some((probe) => probe.id === "health"));
    assert.ok(result.probes.some((probe) => probe.id === "status"));
    assert.ok(result.probes.some((probe) => probe.id === "deadman-read"));
    assert.equal(result.probes.some((probe) => probe.id === "jobs-write"), false);
    assert.equal(result.probes.every((probe) => probe.ok), true);
  } finally {
    if (previous === undefined) delete process.env.CRON_MASTER_API_KEY;
    else process.env.CRON_MASTER_API_KEY = previous;
  }
});
