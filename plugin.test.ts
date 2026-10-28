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

// The two families really are shaped differently, verbatim from the live sites
// (2026-10-28): the openapi balance answers lowercase with a string code, the
// website's login/info answers uppercase with a numeric one.
test("the two envelope shapes the two vendors' hosts answer with", () => {
  const { envelopeOk, envelopeMessage } = _internal
  const balance = {
    success: false,
    request_id: "1becaed1-1b9f-4156-8fa8-a91b41a3b5f5",
    code: "InvalidAuthentication",
    message: "Invalid access token.",
  }
  const loginInfo = {
    Code: 10019901001,
    Message: "禁止访问",
    RequestId: "72e13609-6460-4011-8fca-8dab5f5fe917",
    Success: false,
  }
  expect(envelopeOk(balance)).toBe(false)
  expect(envelopeOk(loginInfo)).toBe(false)
  expect(envelopeMessage(loginInfo)).toBe("禁止访问")
  // and each one's success side
  expect(envelopeOk({ success: true, data: { available_balance: 250 } })).toBe(true)
  expect(envelopeOk({ Code: 200, Data: { NickName: "ada" } })).toBe(true)
})

test("maskToken keeps only the ends", () => {
  expect(_internal.maskToken("ms-abcdef123456")).toBe("ms-ab…456")
  expect(_internal.maskToken("short")).toBe("ms-…")
})

// ---- check-in ----------------------------------------------------------------

test("a successful check-in claims", async () => {
  f.clear()
  const day = _internal.beijingDay()
  let calls = 0
  f.route("GET /api/v1/users/login/info", (r) => {
    expect(r.headers.get("cookie")).toBe("m_session_id=ms-checkin-ok")
    return json({ Code: 200, Data: { NickName: "ada" } })
  })
  f.route("GET /openapi/v1/magicubes/transactions", () => {
    // empty before the trigger, the grant on the read after it
    const granted = calls++ > 0
    return json({ success: true, data: { records: granted
      ? [{ type: "EARN", rule_key: "daily_active", gmt_created: day, total_amount: 200 }]
      : [] } })
  })
  expect(await _internal.checkinImpl(auth("ms-checkin-ok"))).toEqual({
    outcome: "claimed",
    credit: 200,
    message: "签到到账 200 魔粒",
  })
})

test("a check-in whose ledger answers empty is inactive, not a claim", async () => {
  f.clear()
  f.route("GET /api/v1/users/login/info", () => json({ Code: 200, Data: {} }))
  f.route("GET /openapi/v1/magicubes/transactions", () => json({ success: true, data: { records: [] } }))
  expect(await _internal.checkinImpl(auth("ms-checkin-inactive"))).toEqual({
    outcome: "inactive",
    message: "登录已触达，但今天没有到账记录",
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

test("a check-in the ledger can't answer is retried, not claimed", async () => {
  f.clear()
  f.route("GET /openapi/v1/magicubes/transactions", () => new Response("boom", { status: 500 }))
  f.route("GET /api/v1/users/login/info", () => json({ Code: 200, Data: {} }))
  expect(await _internal.checkinImpl(auth("ms-checkin-noledger"))).toEqual({
    outcome: "failed",
    message: "签到已触发，但账单查询失败，稍后会自动重试",
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
  const day = _internal.beijingDay()
  f.route("GET /openapi/v1/magicubes/balance", (r) => {
    // the published contract: bearerAuth on GET /openapi/v1/magicubes/balance
    expect(r.headers.get("authorization")).toBe("Bearer ms-usage-ok")
    return json({ success: true, data: { available_balance: 230, total_balance: 230 } })
  })
  // today's grant, as the ledger proves it: the daily rules paid 250
  f.route("GET /openapi/v1/magicubes/transactions", () =>
    json({ success: true, data: { records: [
      { type: "EARN", rule_key: "daily_active", gmt_created: day, total_amount: 200 },
      { type: "EARN", rule_key: "aliyun_bindlogin", gmt_created: day, total_amount: 50 },
      { type: "SPEND", rule_key: "daily_active", gmt_created: day, total_amount: 20 },
    ] } }),
  )
  const u = await _internal.usageImpl(auth("ms-usage-ok"))
  expect(u.plan).toBe("魔粒")
  expect(u.balance).toBe("230")
  expect(u.windows).toHaveLength(1)
  // spent of today's grant, not of total_balance (which follows availability)
  expect(u.windows[0]!).toMatchObject({ amount: 20, limit: 250, unit: "魔粒", display: "20 / 250" })
  expect(u.windows[0]!.used).toBe(8)
  expect(new Date(u.windows[0]!.resetsAt!).getTime()).toBeGreaterThan(Date.now())
})

test("the balance falls back to the session cookie when bearer is refused", async () => {
  f.clear()
  let calls = 0
  f.route("GET /openapi/v1/magicubes/balance", (r) => {
    calls++
    if (r.headers.get("authorization")) return new Response("no", { status: 401 })
    expect(r.headers.get("cookie")).toBe("m_session_id=ms-usage-cookie")
    return json({ success: true, data: { available_balance: 42, total_balance: 42 } })
  })
  const u = await _internal.usageImpl(auth("ms-usage-cookie"))
  expect(u.balance).toBe("42")
  expect(calls).toBe(2) // bearer first, then the cookie
})

test("a ledger it can't read leaves the card on the balance alone", async () => {
  f.clear()
  f.route("GET /openapi/v1/magicubes/balance", () => json({ success: true, data: { available_balance: 230, total_balance: 230 } }))
  f.route("GET /openapi/v1/magicubes/transactions", () => new Response("boom", { status: 500 }))
  const u = await _internal.usageImpl(auth("ms-usage-noledger"))
  // no grant figure to measure against: report the balance and no window,
  // rather than a made-up "0 / 230"
  expect(u.balance).toBe("230")
  expect(u.windows).toEqual([])
})

// Billing is per call, so a busy day files today's two EARN rows behind whole
// pages of SPEND rows: a first-page-only read would say "no grant today".
test("a busy day files today's grant past the first ledger page", async () => {
  f.clear()
  const day = _internal.beijingDay()
  // 100 rows that add up to the 20 the balance says was spent
  const spend = Array.from({ length: _internal.LEDGER_PAGE }, () => ({
    type: "SPEND_CONFIRM",
    rule_key: "daily_active",
    gmt_created: day,
    total_amount: 0.2,
  }))
  f.route("GET /openapi/v1/magicubes/transactions", (r) => {
    const page = Number(r.query.get("page") || "1")
    return page === 1
      ? json({ success: true, data: { records: spend } })
      : json({ success: true, data: { records: [
          { type: "EARN", rule_key: "daily_active", gmt_created: day, total_amount: 200 },
          { type: "EARN", rule_key: "aliyun_bindlogin", gmt_created: day, total_amount: 50 },
        ] } })
  })
  f.route("GET /openapi/v1/magicubes/balance", () => json({ success: true, data: { available_balance: 230, total_balance: 230 } }))
  const u = await _internal.usageImpl(auth("ms-usage-paged"))
  expect(u.windows[0]!).toMatchObject({ amount: 20, limit: 250, display: "20 / 250" })
})

// Magicubes expire 24h after they are issued, which is not the window's reset:
// the reset is when the next grant lands, the expiry is when what is left is
// lost. magpie draws those two differently (runsOutAt / runsOut), and the
// ledger's stamp is the vendor's Beijing wall clock, not an ISO instant.
test("the window resets at the next grant and says when credits run out", async () => {
  f.clear()
  const day = _internal.beijingDay()
  const expire = new Date(Date.now() + 6 * 3600e3)
  const bj = new Date(expire.getTime() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ")
  f.route("GET /openapi/v1/magicubes/transactions", () =>
    json({ success: true, data: { records: [
      { type: "EARN", rule_key: "daily_active", gmt_created: day, total_amount: 200, expire_at: bj },
      { type: "EARN", rule_key: "aliyun_bindlogin", gmt_created: day, total_amount: 50, expire_at: bj },
      { type: "SPEND_CONFIRM", gmt_created: day, total_amount: 20, count: 10 },
    ] } }),
  )
  f.route("GET /openapi/v1/magicubes/balance", () => json({ success: true, data: { available_balance: 230, total_balance: 230 } }))
  const u = await _internal.usageImpl(auth("ms-usage-expiry"))
  const w = u.windows[0]!
  expect(w.display).toBe("20 / 250 · 10 次调用")
  // the vendor stamped Beijing, so the instant must land there, not 8h off
  expect(Math.abs(new Date(w.runsOutAt!).getTime() - expire.getTime())).toBeLessThan(2000)
  expect(w.runsOut).toBe(230) // the day's grant still unspent
  // the reset is still the next Beijing 00:35, not the expiry
  expect(new Date(w.resetsAt!).getTime()).not.toBe(new Date(w.runsOutAt!).getTime())
})

// A day's credits that expired unused are not spend: the ledger files them as
// their own EXPIRE row, and counting them as use would report a day's burn as
// far more than the calls actually cost.
test("an expiry is not spend", async () => {
  f.clear()
  const day = _internal.beijingDay()
  f.route("GET /openapi/v1/magicubes/transactions", () =>
    json({ success: true, data: { records: [
      { type: "EARN", rule_key: "daily_active", gmt_created: day, total_amount: 200 },
      { type: "EXPIRE", rule_key: "expire", gmt_created: day, total_amount: 235, count: 2 },
      { type: "SPEND_CONFIRM", gmt_created: day, total_amount: 60, count: 30 },
    ] } }),
  )
  f.route("GET /openapi/v1/magicubes/balance", () => json({ success: true, data: { available_balance: 304, total_balance: 304 } }))
  const u = await _internal.usageImpl(auth("ms-usage-expire"))
  expect(u.windows[0]!).toMatchObject({ amount: 60, limit: 200, display: "60 / 200 · 30 次调用" })
})

// A 403 is the vendor's risk control, so the check-in must be retried rather
// than the account marked as needing a new token.
test("a 403 on the check-in is a retry, not an expired sign-in", async () => {
  f.clear()
  f.route("GET /openapi/v1/magicubes/transactions", () => json({ success: true, data: { records: [] } }))
  f.route("GET /api/v1/users/login/info", () => new Response("no", { status: 403 }))
  const r = await _internal.checkinImpl(auth("ms-checkin-403"))
  expect(r.outcome).toBe("failed")
  expect(r.message).toContain("风控")
})

// The check-in is the trigger and the ledger is the proof; the card is its
// own read, so the grant showing up drops the card's cache and the next read
// picks the new numbers up at once.
test("a check-in drops the card, so the grant shows at the next read", async () => {
  f.clear()
  const day = _internal.beijingDay()
  let ledger = 0
  f.route("GET /openapi/v1/magicubes/transactions", () => {
    ledger++
    return json({ success: true, data: { records: [
      { type: "EARN", rule_key: "daily_active", gmt_created: day, total_amount: 200 },
      { type: "EARN", rule_key: "aliyun_bindlogin", gmt_created: day, total_amount: 50 },
    ] } })
  })
  f.route("GET /openapi/v1/magicubes/balance", () => json({ success: true, data: { available_balance: 230, total_balance: 230 } }))
  const token = "ms-usage-seeded"
  // a stale anchor from before the grant
  _internal.liveCache.set(token, {
    at: Date.now() - 40 * 60_000,
    available: 0,
    total: 0,
    sinceBalance: 0,
    ledgerAt: Date.now() - 40 * 60_000,
    day,
    ledger: { found: true, credit: 250, earned: 250, spent: 0, calls: 0 },
    sinceLedger: 0,
  })
  await _internal.checkinImpl(auth(token)) // already granted: done, no trigger
  expect(_internal.liveCache.has(token)).toBe(false) // the grant dropped it
  const u = await _internal.usageImpl(auth(token))
  expect(u.windows[0]!).toMatchObject({ amount: 20, limit: 250, display: "20 / 250" })
  expect(ledger).toBe(2) // the check-in's proof, then the card's own read
})

test("usage reports the hold window when the balance is exhausted", async () => {
  f.clear()
  f.route("GET /openapi/v1/magicubes/balance", () => json({ success: true, data: { available_balance: 0, total_balance: 350 } }))
  const u = await _internal.usageImpl(auth("ms-usage-zero"))
  expect(u.balance).toBe("0")
  // nothing left is nothing left: the hold window, whatever the ledger says
  expect(u.windows[0]!).toMatchObject({ used: 100, display: "今日魔粒已用完" })
  expect(new Date(u.windows[0]!.resetsAt!).getTime()).toBeGreaterThan(Date.now())
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
  const w = _internal.usageCard(600, 600, 0).windows[0]!
  expect(w.used).toBe(0)
  expect(w.display).toBe("0 / 600")
})

test("usage maps a 401 to an expired card", async () => {
  f.clear()
  f.route("GET /openapi/v1/magicubes/balance", () => new Response("no", { status: 401 }))
  const u = await _internal.usageImpl(auth("ms-usage-401"))
  expect(u.signIn).toBe("expired")
})

// The vendor answers 403 as risk control, not as a broken token: the account
// is usually fine, and marking it expired would send the user to re-login.
test("a 403 is risk control, not an expired sign-in", async () => {
  f.clear()
  f.route("GET /openapi/v1/magicubes/balance", () => new Response("no", { status: 403 }))
  const u = await _internal.usageImpl(auth("ms-usage-403"))
  expect(u.signIn).toBeUndefined()
  expect(u.error).toContain("风控")
})

// A refund is a negative spend row: the sum must not surface as a negative
// figure or a negative percentage on the card.
test("a refunded call does not show as negative use", async () => {
  f.clear()
  const day = _internal.beijingDay()
  f.route("GET /openapi/v1/magicubes/transactions", () =>
    json({ success: true, data: { records: [
      { type: "EARN", rule_key: "daily_active", gmt_created: day, total_amount: 250, expire_at: "" },
      { type: "SPEND_CONFIRM", gmt_created: day, total_amount: 20 },
      { type: "SPEND_CONFIRM", gmt_created: day, total_amount: -50 }, // the refund
    ] } }),
  )
  f.route("GET /openapi/v1/magicubes/balance", () => json({ success: true, data: { available_balance: 280, total_balance: 280 } }))
  const u = await _internal.usageImpl(auth("ms-usage-refund"))
  expect(u.windows[0]!).toMatchObject({ amount: 0, limit: 250, display: "0 / 250" })
  expect(u.windows[0]!.used).toBe(0)
})

// magpie's heldUp stops an account on a window reading 100 and no model,
// without consulting the balance: a day that spent past its own grants (out of
// long-term magicubes) must not park an account that can still serve.
test("spending past the day's grants does not park a funded account", async () => {
  f.clear()
  const day = _internal.beijingDay()
  f.route("GET /openapi/v1/magicubes/transactions", () =>
    json({ success: true, data: { records: [
      { type: "EARN", rule_key: "daily_active", gmt_created: day, total_amount: 250 },
      { type: "SPEND_CONFIRM", gmt_created: day, total_amount: 300 },
    ] } }),
  )
  f.route("GET /openapi/v1/magicubes/balance", () => json({ success: true, data: { available_balance: 60, total_balance: 60 } }))
  const u = await _internal.usageImpl(auth("ms-usage-overspend"))
  expect(u.windows[0]!).toMatchObject({ amount: 300, limit: 250 })
  expect(u.windows[0]!.used).toBe(99) // under 100: 60 magicubes are still live
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

// Every vendor read is a web request to a site that answers slowly and forbids
// hammering. One read is held for half an hour; the grant drops it itself, so
// the day boundary is never stale for long.
test("a vendor read is held for half an hour", async () => {
  f.clear()
  let n = 0
  f.route("GET /openapi/v1/magicubes/balance", () => {
    n++
    return json({ success: true, data: { available_balance: 0, total_balance: 350 } })
  })
  const token = "ms-usage-cache-ttl"
  const put = (available: number, ageMs: number) =>
    _internal.liveCache.set(token, {
      at: Date.now() - ageMs,
      available,
      total: 350,
      sinceBalance: 0,
      ledgerAt: Date.now() - ageMs,
      day: _internal.beijingDay(),
      ledger: { found: available > 0, credit: available, earned: 350, spent: 0, calls: 0 },
      sinceLedger: 0,
    })
  put(0, 9 * 60_000) // 9 min old: fresh
  await _internal.usageImpl(auth(token))
  expect(n).toBe(0)
  put(200, 29 * 60_000) // live, 29 min old: still fresh
  await _internal.usageImpl(auth(token))
  expect(n).toBe(0)
  put(200, 31 * 60_000) // past the TTL: read again
  await _internal.usageImpl(auth(token))
  expect(n).toBe(1)
})

// Between vendor reads the card is estimated from the calls that went through
// this plugin, so a page refreshed every minute costs no web request. Each call
// is counted at the top tier's price: overstating the spend is the safe way to
// be wrong, since it can only make the card ask the vendor sooner.
test("calls between reads move the card without asking the vendor", async () => {
  f.clear()
  const day = _internal.beijingDay()
  let balances = 0
  let ledgers = 0
  f.route("GET /openapi/v1/magicubes/balance", () => {
    balances++
    return json({ success: true, data: { available_balance: 200, total_balance: 200 } })
  })
  f.route("GET /openapi/v1/magicubes/transactions", () => {
    ledgers++
    return json({ success: true, data: { records: [
      { type: "EARN", rule_key: "daily_active", gmt_created: day, total_amount: 200 },
      { type: "SPEND_CONFIRM", gmt_created: day, total_amount: 20, count: 10 },
    ] } })
  })
  const token = "ms-usage-estimate"
  const first = await _internal.usageImpl(auth(token))
  expect(balances).toBe(1)
  expect(first.windows[0]!).toMatchObject({ amount: 20, display: "20 / 200 · 10 次调用" })

  // three 200s through the loader: 2 magicubes each, nothing asked of the vendor
  _internal.noteCall(token)
  _internal.noteCall(token)
  _internal.noteCall(token)
  const after = await _internal.usageImpl(auth(token))
  expect(balances).toBe(1) // no new read
  expect(after.windows[0]!).toMatchObject({ amount: 26, display: "26 / 200 · 13 次调用" })
  expect(after.balance).toBe("194")
  expect(ledgers).toBe(1)
})

test("Qwen-Ambassador models are marked deprecated to hide from picker", async () => {
  f.clear()
  f.route("GET /v1/models", () =>
    json({
      data: [
        { id: "deepseek-ai/DeepSeek-V4.1-Flash", created: 1789386292 },
        { id: "Qwen-Ambassador/Qwen2.5-VL-72B-Instruct", created: 1789380000 },
      ],
    }),
  )
  const got = await _internal.modelsImpl({ models: {} }, { auth: auth("ms-models-ambassador") })
  const live = got["deepseek-ai/DeepSeek-V4.1-Flash"]!
  expect(live.status).toBe("active")
  expect(live.name).toBe("DeepSeek V4.1 Flash")
  expect(live.release_date).toBe("2026-09-14")
  expect(got["Qwen-Ambassador/Qwen2.5-VL-72B-Instruct"]!.status).toBe("deprecated")
})

// The estimate is only trusted while it says there is room; near zero the
// next read goes to the vendor, because a wrong "still yours" would keep
// sending calls that answer 402.
test("an account nearly out is read from the vendor again", async () => {
  f.clear()
  let n = 0
  f.route("GET /openapi/v1/magicubes/balance", () => {
    n++
    return json({ success: true, data: { available_balance: 200, total_balance: 200 } })
  })
  f.route("GET /openapi/v1/magicubes/transactions", () =>
    json({ success: true, data: { records: [
      { type: "EARN", rule_key: "daily_active", gmt_created: _internal.beijingDay(), total_amount: 200 },
    ] } }),
  )
  const token = "ms-usage-nearly-out"
  await _internal.usageImpl(auth(token))
  expect(n).toBe(1)
  // 98 calls at 2 each: 4 magicubes left, which is SYNC_BELOW
  for (let i = 0; i < 98; i++) _internal.noteCall(token)
  await _internal.usageImpl(auth(token))
  expect(n).toBe(2) // read again: the estimate says it is nearly out
})

// The regression this guards: reading the ledger alongside every balance read
// turns one cheap read into four (three pages), and five accounts of that
// overran magpie's usage timeout. The ledger is the day's, so it is read once.
test("the ledger is read once a day, not on every balance sync", async () => {
  f.clear()
  let balances = 0
  let ledgers = 0
  f.route("GET /openapi/v1/magicubes/balance", () => {
    balances++
    return json({ success: true, data: { available_balance: 200, total_balance: 200 } })
  })
  f.route("GET /openapi/v1/magicubes/transactions", () => {
    ledgers++
    return json({ success: true, data: { records: [
      { type: "EARN", rule_key: "daily_active", gmt_created: _internal.beijingDay(), total_amount: 200 },
    ] } })
  })
  const token = "ms-usage-ledger-once"
  await _internal.usageImpl(auth(token))
  expect([balances, ledgers]).toEqual([1, 1])
  _internal.liveCache.get(token)!.at = Date.now() - 31 * 60_000 // the balance anchor ages out
  await _internal.usageImpl(auth(token))
  expect([balances, ledgers]).toEqual([2, 1]) // the day's ledger is still good
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
  // an unknown id keeps a sane, non-crashing shape, and its name is read off
// the vendor's id rather than left as the raw slug
  const unk = got["some/Unknown-Model"]!
  expect(unk.name).toBe("Unknown Model")
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
