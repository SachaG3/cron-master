import { NextRequest } from "next/server";

const API_URL = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");

function responseHeadersFromBackend(response: Response) {
  const headers = new Headers(response.headers);
  const backendHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = backendHeaders.getSetCookie?.() ?? [];

  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.delete("set-cookie");

  for (const cookie of setCookies) {
    headers.append("set-cookie", cookie);
  }

  return headers;
}

async function proxy(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await context.params;
  const target = new URL(`${API_URL}/${path.map(encodeURIComponent).join("/")}`);
  target.search = request.nextUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeadersFromBackend(response),
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
