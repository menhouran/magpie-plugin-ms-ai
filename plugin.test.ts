// The plugin's own logic against a local fake of ModelScope's hosts: the
// envelope's two casings, the check-in's outcomes, the usage card, the
// exhausted-balance 429, and the models fetch with its fallback. Nothing
// here reaches modelscope.ai (nonet.ts blocks it).
import "./nonet.ts"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { json, startFake } from "./fake.ts"

type PluginModule = typeof import("./index.ts")
type Fake = ReturnType<typeof startFake>

let f: Fake
let _internal: PluginModule["_internal"]
let ModelScopeAuthPlugin: PluginModule["ModelScopeAuthPlugin"]

beforeAll(async () => {
  f = startFake()
  process.env.MODELSCOPE_SITE_URL = f.origin
  process.env.MODELSCOPE_API_BASE = f.origin + "/v1"
  ;({ _internal, ModelScopeAuthPlugin } = await import("./index.ts"))
})
afterAll(() => f?.close())

const auth = (key: string): { type: "api"; key: string } => ({ type: "api", key })

// ---- envelope parsing --------------------------------------------------------

test("envelopeOk accepts both casings and treats a missing code as ok", () => {
  const { envelopeOk } = _internal
  expect(envelopeOk({ Success: true })).toBe(true)
  expect(envelopeOk({ success: false })).toBe(false)
  expect(envelopeOk({ Code: 200 })).toBe(true)
  expect(envelopeOk({ code: 200 })).toBe(true)
  expect(envelopeOk({ Code: 500 })).toBe(false)
  expect(envelopeOk({})).toBe(true)
})

test("envelopeData and envelopeMessage read either casing", () => {
  const { envelopeData, envelopeMessage } = _internal
  expect(envelopeData({ Data: { available_balance: 5 } }).available_balance).toBe(5)
  expect(envelopeData({ data: { available_balance: 7 } }).available_balance).toBe(7)
  expect(envelopeData({}).available_balance).toBeUndefined()
  expect(envelopeMessage({ Message: "x" })).toBe("x")
  expect(envelopeMessage({ msg: "y" })).toBe("y")
})

test("maskToken keeps only the ends", () => {
  expect(_internal.maskToken("ms-abcdef123456")).toBe("ms-ab…456")
  expect(_internal.maskToken("short")).toBe("ms-…")
})

// ---- check-in ----------------------------------------------------------------

test("a successful check-in claims", async () => {
  f.clear()
  f.route("GET /api/v1/users/login/info", (r) => {
    expect(r.headers.get("cookie")).toBe("m_session_id=ms-checkin-ok")
    return json({ Code: 200, Data: { NickName: "ada" } })
  })
  expect(await _internal.checkinImpl(auth("ms-checkin-ok"))).toEqual({
    outcome: "claimed",
    message: "每日登录奖励已触发",
  })
})

test("a failed envelope answers failed, not a throw", async () => {
  f.clear()
  f.route("GET /api/v1/users/login/info", () => json({ code: 500, message: "boom" }))
  const r = await _internal.checkinImpl(auth("ms-checkin-fail"))
  expect(r.outcome).toBe("failed")
  expect(r.message).toContain("boom")
})

test("a 401 on check-in throws with signIn expired", async () => {
  f.clear()
  f.route("GET /api/v1/users/login/info", () => new Response("no", { status: 401 }))
  await expect(_internal.checkinImpl(auth("ms-checkin-401"))).rejects.toMatchObject({ signIn: "expired" })
})

// ---- exhausted balance → daily hold window -----------------------------------

test("nextBeijingReset lands on 00:35 Beijing, in the future", () => {
  const iso = _internal.nextBeijingReset(Date.UTC(2026, 9, 27, 12, 0, 0)) // 20:00 Beijing
  const t = new Date(iso)
  // read back through Beijing wall clock
  const bj = new Date(t.getTime() + 8 * 3600e3)
  expect(bj.getUTCHours()).toBe(0)
  expect(bj.getUTCMinutes()).toBe(35)
  expect(bj.getUTCDate()).toBe(28) // rolled to the next Beijing day
  expect(t.getTime()).toBeGreaterThan(Date.UTC(2026, 9, 27, 12, 0, 0))
})

test("nextBeijingReset before 00:35 Beijing targets today's 00:35", () => {
  const iso = _internal.nextBeijingReset(Date.UTC(2026, 9, 27, 15, 0, 0)) // 23:00 Beijing, prior day
  const bj = new Date(new Date(iso).getTime() + 8 * 3600e3)
  expect(bj.getUTCHours()).toBe(0)
  expect(bj.getUTCMinutes()).toBe(35)
})

// The call bucket is dead: billing is per-call magicubes since 2026-08, so a
// 429 is a pure throttle (magpie backs off) and exhaustion answers 402 — no
// per-minute balance peeks, no per-day call-count windows.

test("exhaustedWindow is what magpie's heldUp reads to sit an account out", () => {
  const w = _internal.exhaustedWindow()[0]!
  expect(w.used).toBe(100)
  expect(w.span).toBe(86400) // >= 24h feeds autoReset too
  expect(new Date(w.resetsAt!).getTime()).toBeGreaterThan(Date.now())
})

test("a check-in already granted today answers done, with its credit", async () => {
  f.clear()
  const day = _internal.beijingDay()
  f.route("GET /openapi/v1/magicubes/transactions", () =>
    json({
      success: true,
      data: {
        records: [
          { type: "EARN", rule_key: "daily_active", gmt_created: day, total_amount: 200 },
          { type: "EARN", rule_key: "aliyun_bindlogin", gmt_created: day, total_amount: 50 },
          { type: "EARN", rule_key: "daily_active", gmt_created: "2026-10-26", total_amount: 200 },
          { type: "SPEND", rule_key: "daily_active", gmt_created: day, total_amount: 9 },
        ],
      },
    }),
  )
  expect(await _internal.checkinImpl(auth("ms-checkin-done"))).toEqual({
    outcome: "done",
    credit: 250,
    message: "今日已领取 250 魔粒",
  })
})

test("a trigger that lands a grant is claimed, with the ledger's credit", async () => {
  f.clear()
  let calls = 0
  f.route("GET /openapi/v1/magicubes/transactions", () => {
    calls++
    return calls === 1
      ? json({ success: true, data: { records: [] } })
      : json({ success: true, data: { records: [{ type: "EARN", rule_key: "daily_active", gmt_created: _internal.beijingDay(), total_amount: 200 }] } })
  })
  f.route("GET /api/v1/users/login/info", () => json({ Code: 200, Data: {} }))
  expect(await _internal.checkinImpl(auth("ms-checkin-credit"))).toEqual({
    outcome: "claimed",
    credit: 200,
    message: "签到到账 200 魔粒",
  })
  expect(calls).toBe(2)
})

test("a trigger with no ledger answer still claims", async () => {
  f.clear()
  f.route("GET /openapi/v1/magicubes/transactions", () => new Response("boom", { status: 500 }))
  f.route("GET /api/v1/users/login/info", () => json({ Code: 200, Data: {} }))
  expect(await _internal.checkinImpl(auth("ms-checkin-noledger"))).toEqual({
    outcome: "claimed",
    message: "每日登录奖励已触发",
  })
})

test("a check-in saves the ModelScope user name as the account's name", async () => {
  f.clear()
  let saved: any = null
  f.route("GET /openapi/v1/magicubes/transactions", () => json({ success: true, data: { records: [] } }))
  f.route("GET /api/v1/users/login/info", () =>
    json({ Code: 200, Data: { NickName: "ada", HavanaId: "237530814136320" } }),
  )
  const p = await ModelScopeAuthPlugin({
    client: { auth: { set: async (args) => { saved = args } } },
  })
  await p.auth.checkin(async () => ({ type: "api", key: "ms-name-ok" }))
  expect(saved.path).toEqual({ id: "modelscope-ai" })
  expect(saved.body).toMatchObject({
    type: "api",
    key: "ms-name-ok",
    accountId: "ada",
    uid: "237530814136320",
  })
})

// ---- usage -------------------------------------------------------------------

test("usage reports magicubes as a credits window with real numbers", async () => {
  f.clear()
  f.route("GET /openapi/v1/magicubes/balance", (r) => {
    expect(r.headers.get("cookie")).toBe("m_session_id=ms-usage-ok")
    return json({ success: true, data: { available_balance: 238, total_balance: 350 } })
  })
  const u = await _internal.usageImpl(auth("ms-usage-ok"))
  expect(u.plan).toBe("魔粒")
  expect(u.balance).toBe("238")
  expect(u.windows).toHaveLength(1)
  expect(u.windows[0]!).toMatchObject({ amount: 112, limit: 350, unit: "魔粒", display: "112 / 350" })
  expect(Math.round(u.windows[0]!.used)).toBe(32)
  expect(new Date(u.windows[0]!.resetsAt!).getTime()).toBeGreaterThan(Date.now())
})

test("usage reports the hold window when the balance is exhausted", async () => {
  f.clear()
  f.route("GET /openapi/v1/magicubes/balance", () => json({ success: true, data: { available_balance: 0, total_balance: 350 } }))
  const u = await _internal.usageImpl(auth("ms-usage-zero"))
  expect(u.balance).toBe("0")
  expect(u.windows[0]!).toMatchObject({ used: 100, amount: 350, limit: 350 })
})

test("usage holds when no cubes are live at all", async () => {
  f.clear()
  f.route("GET /openapi/v1/magicubes/balance", () => json({ success: true, data: { available_balance: 0, total_balance: 0 } }))
  const u = await _internal.usageImpl(auth("ms-usage-none"))
  expect(u.windows[0]!).toMatchObject({ used: 100 })
  expect(new Date(u.windows[0]!.resetsAt!).getTime()).toBeGreaterThan(Date.now())
})

test("usage skips the window when the balance field is missing", async () => {
  f.clear()
  f.route("GET /openapi/v1/magicubes/balance", () => json({ success: true, data: {} }))
  const u = await _internal.usageImpl(auth("ms-usage-missing"))
  expect(u.windows).toEqual([])
  expect(u.balance).toBeUndefined()
})

test("usageCard counts a full grant as 0 used", () => {
  const w = _internal.usageCard(600, 600).windows[0]!
  expect(w.used).toBe(0)
  expect(w.display).toBe("0 / 600")
})

test("usage maps a 401 to an expired card", async () => {
  f.clear()
  f.route("GET /openapi/v1/magicubes/balance", () => new Response("no", { status: 403 }))
  const u = await _internal.usageImpl(auth("ms-usage-403"))
  expect(u.signIn).toBe("expired")
})

test("usage answers from cache within the TTL", async () => {
  f.clear()
  let n = 0
  f.route("GET /openapi/v1/magicubes/balance", () => {
    n++
    return json({ success: true, data: { available_balance: 10, total_balance: 10 } })
  })
  await _internal.usageImpl(auth("ms-usage-cache"))
  await _internal.usageImpl(auth("ms-usage-cache"))
  expect(n).toBe(1)
})

// An exhausted balance moves only at the next grant, and the grant drops the
// cache itself (checkin's ledger read), so its read is held 30 minutes, not 10.
test("an exhausted balance is held longer than a live one", async () => {
  f.clear()
  let n = 0
  f.route("GET /openapi/v1/magicubes/balance", () => {
    n++
    return json({ success: true, data: { available_balance: 0, total_balance: 350 } })
  })
  const token = "ms-usage-exhausted-ttl"
  const put = (available: number, ageMs: number) =>
    _internal.cubesCache.set(token, { at: Date.now() - ageMs, value: { available, total: 350 } })
  put(0, 9 * 60_000) // exhausted, 9 min old: still fresh at the long TTL
  await _internal.usageImpl(auth(token))
  expect(n).toBe(0)
  put(0, 11 * 60_000) // exhausted, 11 min old: past the short TTL, inside the long one
  await _internal.usageImpl(auth(token))
  expect(n).toBe(0)
  put(0, 31 * 60_000) // past even the exhausted TTL: read again
  await _internal.usageImpl(auth(token))
  expect(n).toBe(1)
  put(200, 11 * 60_000) // live but 11 min old: past the short TTL, read again
  await _internal.usageImpl(auth(token))
  expect(n).toBe(2)
})

test("models are cached per account, once within the TTL", async () => {
  f.clear()
  let n = 0
  f.route("GET /v1/models", () => {
    n++
    return json({ data: [{ id: "zai-org/GLM-5.2" }] })
  })
  const provider = { models: {} }
  const got1 = await _internal.modelsImpl(provider, { auth: auth("ms-models-cache") })
  const got2 = await _internal.modelsImpl(provider, { auth: auth("ms-models-cache") })
  expect(n).toBe(1)
  expect(got2).toBe(got1)
  await _internal.modelsImpl(provider, { auth: auth("ms-models-cache-2") }) // another account: its own read
  expect(n).toBe(2)
})

test("usage names an account that has none, once", async () => {
  f.clear()
  let saved: any = null
  let info = 0
  f.route("GET /openapi/v1/magicubes/balance", () => json({ success: true, data: { available_balance: 5, total_balance: 10 } }))
  f.route("GET /api/v1/users/login/info", () => {
    info++
    return json({ Code: 200, Data: { NickName: "ada", HavanaId: "1" } })
  })
  const p = await ModelScopeAuthPlugin({ client: { auth: { set: async (a) => { saved = a } } } })
  await p.auth.usage(async () => ({ type: "api", key: "ms-usage-naming" }))
  expect(saved.body).toMatchObject({ accountId: "ada", key: "ms-usage-naming" })
  expect(info).toBe(1)
  await p.auth.usage(async () => ({ type: "api", key: "ms-usage-naming" })) // cached
  expect(info).toBe(1)
})

// ---- models ------------------------------------------------------------------

test("models lists what the vendor returns, unfiltered", async () => {
  f.clear()
  f.route("GET /v1/models", (r) => {
    expect(r.headers.get("authorization")).toBe("Bearer ms-models-ok")
    return json({ object: "list", data: [
      { id: "zai-org/GLM-5.2" },
      { id: "Menlo/Jan-nano" },
      { id: "some/Brand-New-Model" },
    ] })
  })
  const provider = { models: {} }
  const got = await _internal.modelsImpl(provider, { auth: auth("ms-models-ok") })
  expect(Object.keys(got).sort()).toEqual(["Menlo/Jan-nano", "some/Brand-New-Model", "zai-org/GLM-5.2"])
  // a known id keeps its real limits; an unknown one gets a safe default
  expect(got["zai-org/GLM-5.2"]!.limit.context).toBe(1048576)
  expect(got["some/Brand-New-Model"]!.limit).toEqual({ context: 128000, output: 8192 })
})

// The whole point of the fix: a hook's entries are taken as they are and magpie
// reads capabilities off them (host.js models map: reasoning/toolcall/input),
// so a compact models.dev declaration would list every model as unable to
// reason, call tools or see images. Each entry is the full OpenCode model.
test("models returns full entries magpie reads capabilities off", async () => {
  f.clear()
  f.route("GET /v1/models", () => json({ data: [
    { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017" },
    { id: "some/Unknown-Model" },
  ] }))
  const got = await _internal.modelsImpl({ models: {} }, { auth: auth("ms-models-shape") })
  const known = got["deepseek-ai/DeepSeek-V4.1-Flash-1017"]!
  expect(known.providerID).toBe("modelscope-ai")
  expect(known.status).toBe("active")
  expect(known.api).toMatchObject({ id: known.id, npm: "@ai-sdk/openai-compatible" })
  expect(known.api.url).toBe(_internal.API_BASE)
  expect(known.capabilities.reasoning).toBe(true)
  expect(known.capabilities.toolcall).toBe(true)
  expect(known.capabilities.input.image).toBe(true) // the seed says image
  expect(known.capabilities.input.text).toBe(true)
  expect(known.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  // an unknown id keeps a sane, non-crashing shape
  const unk = got["some/Unknown-Model"]!
  expect(unk.name).toBe("some/Unknown-Model")
  expect(unk.capabilities.input.image).toBe(false)
  expect(unk.capabilities.input.text).toBe(true)
  expect(unk.capabilities.toolcall).toBe(true) // the vendor's default
  expect(unk.limit).toEqual({ context: 128000, output: 8192 })
})

test("modelEntry builds every capability kind magpie reads", () => {
  const m = _internal.modelEntry("zai-org/GLM-5.2")
  for (const k of ["text", "image", "audio", "video", "pdf"]) expect(k in m.capabilities.input).toBe(true)
  expect(m.capabilities.input.image).toBe(false) // GLM-5.2 seed has no modalities
  expect(m.capabilities.toolcall).toBe(true)
  expect(m.limit.context).toBe(1048576)
})

test("models keeps the built-in list when the fetch fails", async () => {
  f.clear()
  f.route("GET /v1/models", () => new Response("boom", { status: 500 }))
  const provider = { models: { "zai-org/GLM-5.2": _internal.modelEntry("zai-org/GLM-5.2") } }
  const got = await _internal.modelsImpl(provider, { auth: auth("ms-models-500") })
  expect(got).toBe(provider.models)
})

test("models without an api sign-in returns the provider's list untouched", async () => {
  const provider = { models: { "zai-org/GLM-5.2": _internal.modelEntry("zai-org/GLM-5.2") } }
  expect(await _internal.modelsImpl(provider, {})).toBe(provider.models)
})

test("a 401 on models throws with signIn expired", async () => {
  f.clear()
  f.route("GET /v1/models", () => new Response("no", { status: 401 }))
  const provider = { models: { "zai-org/GLM-5.2": _internal.modelEntry("zai-org/GLM-5.2") } }
  await expect(_internal.modelsImpl(provider, { auth: auth("ms-models-401") })).rejects.toMatchObject({ signIn: "expired" })
})

// ---- plugin shape ------------------------------------------------------------

test("the plugin exposes the hooks magpie calls", async () => {
  const p = await ModelScopeAuthPlugin({ client: {} })
  expect(p.auth.provider).toBe("modelscope-ai")
  expect(p.auth.icon).toMatch(/^data:image\/svg\+xml;base64,/)
  expect(p.auth.methods[0]).toMatchObject({ type: "api", placeholder: "ms-…" })
  expect(typeof p.auth.loader).toBe("function")
  expect(typeof p.auth.usage).toBe("function")
  expect(typeof p.auth.checkin).toBe("function")
  expect(p.provider.id).toBe("modelscope-ai")

  const cfg: any = {}
  await p.config(cfg)
  expect(cfg.provider["modelscope-ai"]).toMatchObject({
    name: "ModelScope",
    npm: "@ai-sdk/openai-compatible",
    api: _internal.API_BASE,
  })
})

test("config never overwrites a provider the user set", async () => {
  const p = await ModelScopeAuthPlugin({ client: {} })
  const cfg = { provider: { "modelscope-ai": { name: "Mine" } } }
  await p.config(cfg)
  expect(cfg.provider["modelscope-ai"].name).toBe("Mine")
})

test("the loader's fetch sends Bearer and passes the vendor's answer through", async () => {
  f.clear()
  f.route("POST /v1/chat/completions", (r) => {
    expect(r.headers.get("authorization")).toBe("Bearer ms-loader")
    return new Response(JSON.stringify({ message: "魔粒不足" }), { status: 402 })
  })
  const p = await ModelScopeAuthPlugin({ client: {} })
  const loader = await p.auth.loader(async () => auth("ms-loader"))
  expect(loader.baseURL).toBe(_internal.API_BASE)
  const res = await loader.fetch!(_internal.API_BASE + "/chat/completions", { method: "POST", body: "{}" })
  expect(res.status).toBe(402) // untouched: magpie fails over on it itself
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept") // credits, not the sign-in
})

test("a 401 in fetch marks the sign-in expired, body untouched", async () => {
  f.clear()
  f.route("POST /v1/chat/completions", () =>
    new Response(JSON.stringify({ error: { message: "bad token" } }), { status: 401 }),
  )
  const p = await ModelScopeAuthPlugin({ client: {} })
  const loader = await p.auth.loader(async () => auth("ms-401-mark"))
  const res = await loader.fetch!(_internal.API_BASE + "/chat/completions", { method: "POST", body: "{}" })
  expect(res.status).toBe(401)
  expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
  expect((await res.json()).error.message).toBe("bad token")
})

test("a 403 keeps the account: model access, not the sign-in", async () => {
  f.clear()
  f.route("POST /v1/chat/completions", () => new Response("no access", { status: 403 }))
  const p = await ModelScopeAuthPlugin({ client: {} })
  const loader = await p.auth.loader(async () => auth("ms-403-mark"))
  const res = await loader.fetch!(_internal.API_BASE + "/chat/completions", { method: "POST", body: "{}" })
  expect(res.status).toBe(403)
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
})

test("a 402 in fetch drops the cached balance so the hold lands at once", async () => {
  f.clear()
  let balanceReads = 0
  f.route("GET /openapi/v1/magicubes/balance", () => {
    balanceReads++
    return json({ success: true, data: { available_balance: 0, total_balance: 0 } })
  })
  f.route("POST /v1/chat/completions", () => new Response("out", { status: 402 }))
  const p = await ModelScopeAuthPlugin({ client: {} })
  await _internal.usageImpl(auth("ms-drop")) // fills the cache
  expect(balanceReads).toBe(1)
  const loader = await p.auth.loader(async () => auth("ms-drop"))
  await loader.fetch!(_internal.API_BASE + "/chat/completions", { method: "POST", body: "{}" })
  await _internal.usageImpl(auth("ms-drop")) // cache was dropped, reads again
  expect(balanceReads).toBe(2)
})

// A 429 is a pure throttle under the magicube billing: the answer passes
// through and magpie backs off — the plugin burns no balance read on it.
test("a 429 passes through without touching the balance endpoint", async () => {
  f.clear()
  let reads = 0
  f.route("GET /openapi/v1/magicubes/balance", () => {
    reads++
    return json({ success: true, data: { available_balance: 5, total_balance: 10 } })
  })
  f.route("POST /v1/chat/completions", () => new Response("slow down", { status: 429 }))
  const p = await ModelScopeAuthPlugin({ client: {} })
  const loader = await p.auth.loader(async () => auth("ms-peek"))
  const r1 = await loader.fetch!(_internal.API_BASE + "/chat/completions", { method: "POST", body: "{}" })
  expect(r1.status).toBe(429)
  expect(r1.headers.get("x-magpie-sign-in")).toBe("kept")
  await Bun.sleep(10) // nothing runs behind the reply either
  expect(reads).toBe(0)
})
