import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.TEST_API_BASE_URL?.replace(/\/$/, "");

function cookieHeader(headers: Headers) {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  return getSetCookie?.map((cookie) => cookie.split(";")[0]).join("; ") || headers.get("set-cookie")?.split(";")[0] || "";
}

test("auth and job dry-run flow over HTTP", { skip: !baseUrl }, async () => {
  assert.ok(baseUrl);

  const setup = await fetch(`${baseUrl}/auth/setup-status`);
  assert.equal(setup.status, 200);
  const setupBody = (await setup.json()) as { needsSetup: boolean };
  if (!setupBody.needsSetup) {
    return;
  }

  const credentials = { email: `admin-${Date.now()}@example.com`, password: "password123" };
  const register = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials),
  });
  assert.equal(register.status, 201);

  const cookie = cookieHeader(register.headers);
  assert.ok(cookie.includes("cron_master_session="));

  const me = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);

  const dryRun = await fetch(`${baseUrl}/jobs/test`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: "Integration dry-run",
      type: "notification",
      scheduleType: "once",
      runAt: new Date(Date.now() + 60_000).toISOString(),
      config: { message: "hello" },
    }),
  });
  assert.equal(dryRun.status, 200);
  assert.equal(((await dryRun.json()) as { status: string }).status, "success");

  const openapi = await fetch(`${baseUrl}/openapi.json`);
  assert.equal(openapi.status, 200);
});
