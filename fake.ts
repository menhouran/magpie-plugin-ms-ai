// A fake of ModelScope's hosts for the tests: one local server standing in
// for www.modelscope.ai and api-inference.modelscope.ai, which the plugin's
// SITE and API_BASE env overrides are pointed at. route(method, path)
// answers a request; seen lists what came.
export type FakeRequest = { method: string; path: string; query: URLSearchParams; headers: Headers }
export type FakeHandler = (r: FakeRequest) => Response | Promise<Response>

export const json = (v: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(v), {
    headers: { "content-type": "application/json" },
    ...init,
  })

export function startFake() {
  const routes = new Map<string, FakeHandler>()
  const seen: FakeRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      const r: FakeRequest = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers }
      seen.push(r)
      const h = routes.get(req.method + " " + url.pathname)
      if (!h) return new Response("no route " + req.method + " " + url.pathname, { status: 404 })
      return h(r)
    },
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    seen,
    route: (key: string, handler: FakeHandler) => routes.set(key, handler),
    clear: () => (routes.clear(), (seen.length = 0)),
    close: () => server.stop(true),
  }
}