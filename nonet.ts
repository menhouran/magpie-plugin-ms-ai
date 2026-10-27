// Imported first by every test here: nothing a test runs reaches ModelScope.
// fetch goes only to this machine (the test's fake) or fails, so a test left
// without its fake, or work still going after it, can't send a token to
// modelscope.ai or anywhere else.
const local = (u: string): boolean => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u)
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!local(u)) throw new Error("a test asked " + u + " with no fake in place")
  return realFetch(input, init)
}) as typeof fetch