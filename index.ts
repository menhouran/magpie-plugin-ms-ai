// OpenCode provider plugin: ModelScope international (modelscope.ai) API-Inference.
// The ms- token is dual-purpose: Bearer for inference, m_session_id cookie for web APIs.
// Web-API envelopes are inconsistent (Code/Success/Data or code/success/data) — both accepted.
//
// Bun runs this TypeScript as is, so the package ships no build step.

type Auth = { type: "api"; key: string; [extra: string]: unknown }

// The web APIs answer Code/Success/Data or code/success/data, and body words
// like msg. Both casings are read.
type Envelope = {
  Code?: number | string
  code?: number | string
  Success?: boolean
  success?: boolean
  Message?: string
  message?: string
  msg?: string
  Data?: Record<string, unknown>
  data?: Record<string, unknown>
}

type MagicubeData = {
  available_balance?: number | string
  total_balance?: number | string
  frozen_amount?: number | string
}

// What an inference response's ratelimit headers said: the account's calls
// left today (all models together) against its daily limit. The vendor
// resets both at Beijing midnight.
type CallQuota = { remaining: number; limit: number; at: number }

type UsageWindow = {
  name: string
  used: number
  amount?: number
  limit?: number
  unit?: string
  display?: string
  span?: number
  resetsAt?: string
}

type UsageCard = {
  plan?: string
  balance?: string
  user?: string
  windows: UsageWindow[]
  error?: string
  signIn?: "expired" | "kept" | "renewed"
}

type CheckinResult = {
  outcome: "claimed" | "done" | "failed"
  message?: string
  credit?: number
  streak?: number
}

// The models.dev-style declaration a model keeps in the fallback table.
type ModelSeed = {
  name: string
  limit: { context: number; output: number }
  reasoning?: boolean
  tool_call?: boolean
  modalities?: { input: string[]; output: string[] }
}

// What the models hook returns: the full OpenCode model magpie reads
// (limit, capabilities, api), not the compact declaration — magpie takes a
// hook's entries as they are and reads capabilities, so compact entries
// would list every model as unable to reason, call tools or see images.
type ModelEntry = {
  id: string
  providerID: string
  name: string
  api: { id: string; url: string; npm: string }
  status: "active"
  limit: { context: number; output: number }
  cost: { input: number; output: number; cache: { read: number; write: number } }
  options: Record<string, never>
  headers: Record<string, never>
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: Record<"text" | "image" | "audio" | "video" | "pdf", boolean>
    output: Record<"text" | "image" | "audio" | "video" | "pdf", boolean>
    interleaved: boolean
  }
  release_date: string
  variants: Record<string, never>
}

type Models = Record<string, ModelEntry>
type CacheEntry<T> = { at: number; value: T }
type GetAuth = () => Promise<Auth | undefined>
type PluginConfig = { provider?: Record<string, unknown> }
type ClientAuth = {
  set?: (args: { path: { id: string }; body: unknown }) => Promise<unknown>
}
type PluginInput = { client?: { auth?: ClientAuth } }

const PROVIDER = "modelscope-ai"
const SDK = "@ai-sdk/openai-compatible"
// Overridable for tests and exotic deployments (the raccoon plugin's pattern).
const API_BASE = (process.env.MODELSCOPE_API_BASE || "https://api-inference.modelscope.ai/v1").replace(/\/+$/, "")
const SITE = (process.env.MODELSCOPE_SITE_URL || "https://www.modelscope.ai").replace(/\/+$/, "")
const LOGIN_INFO_PATH = "/api/v1/users/login/info"
const BALANCE_PATH = "/openapi/v1/magicubes/balance"
const TXNS_PATH = "/openapi/v1/magicubes/transactions"
const MODELS_PATH = "/models"
// How long a web-API or /models call waits before it is given up on; a
// vendor that never answers must not park a quota read or a listing.
const TIMEOUT_MS = 20_000
// The rules that pay the daily grant; other EARN rows (invites, events) are
// not today's check-in.
const DAILY_RULES = ["daily_active", "aliyun_bindlogin"]
// The ModelScope mark (magpie's own icon set), inlined so it draws without
// outbound access.
const ICON =
  "data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+TW9kZWxTY29wZTwvdGl0bGU+PHBhdGggZD0iTTAgNy45NjdoMi42Njd2Mi42NjdIMHpNOCAxMC42MzNoMi42NjdWMTMuM0g4eiIgZmlsbD0iIzM2Q0VEMCI+PC9wYXRoPjxwYXRoIGQ9Ik0wIDEwLjYzM2gyLjY2N1YxMy4zSDB6TTIuNjY3IDEzLjNoMi42NjZ2Mi42NjdIOHYyLjY2NkgyLjY2N1YxMy4zek0yLjY2NyA1LjNIOHYyLjY2N0g1LjMzM3YyLjY2NkgyLjY2N1Y1LjN6TTEwLjY2NyAxMy4zaDIuNjY3djIuNjY3aC0yLjY2N3oiIGZpbGw9IiM2MjRBRkYiPjwvcGF0aD48cGF0aCBkPSJNMjQgNy45NjdoLTIuNjY3djIuNjY3SDI0ek0xNiAxMC42MzNoLTIuNjY3VjEzLjNIMTZ6IiBmaWxsPSIjMzZDRUQwIj48L3BhdGg+PHBhdGggZD0iTTI0IDEwLjYzM2gtMi42NjdWMTMuM0gyNHpNMjEuMzMzIDEzLjNoLTIuNjY2djIuNjY3SDE2djIuNjY2aDUuMzMzVjEzLjN6TTIxLjMzMyA1LjNIMTZ2Mi42NjdoMi42Njd2Mi42NjZoMi42NjZWNS4zeiIgZmlsbD0iIzYyNEFGRiI+PC9wYXRoPjwvc3ZnPg=="

// magpie schedules the check-in itself — once per account per Beijing day,
// a failure retried half an hour later — so the plugin adds no throttle or
// time gate of its own there; the vendor is idempotent anyway. The balance
// read is cached 10 minutes per account so the quota page doesn't hammer the
// vendor's web API on every refresh — 30 while the account is exhausted,
// since nothing short of the next grant moves that number, and the grant
// itself drops the cache the moment the ledger confirms it.
const USAGE_TTL_MS = 10 * 60 * 1000
const EXHAUSTED_TTL_MS = 30 * 60 * 1000
// The account's /v1/models list, cached the same way; the hook is asked on
// every listing, and the vendor's answer changes on model-release days, not
// between two requests.
const MODELS_TTL_MS = 10 * 60 * 1000
function cubesTtl(exhausted: boolean): number {
  // exhausted: a spent balance moves only at the next grant, so its read
  // stays good three times as long.
  return exhausted ? EXHAUSTED_TTL_MS : USAGE_TTL_MS
}
// A call-quota reading older than a day says nothing (the vendor resets
// daily); one older than this isn't worth a window's row either.
const CALLS_KEEP_MS = 60 * 60 * 1000
// Per-account state keyed by token. Tokens are few; anything past this many
// entries is pruned oldest-first, so a long-lived host can't grow it forever.
const STATE_MAX = 256

function prune<T>(map: Map<string, CacheEntry<T>>): void {
  if (map.size <= STATE_MAX) return
  const keys = [...map.keys()].slice(0, map.size - STATE_MAX)
  for (const k of keys) map.delete(k)
}

function pruneAt(map: Map<string, number>): void {
  if (map.size <= STATE_MAX) return
  const keys = [...map.keys()].slice(0, map.size - STATE_MAX)
  for (const k of keys) map.delete(k)
}

// The magicube balance as last read, per token: the numbers, not a composed
// card — the calls window moves on every inference response, so the card is
// composed at read time from both.
const cubesCache = new Map<string, CacheEntry<{ available: number; total: number }>>()
// The account's own /v1/models answer, per token: the hook is asked on every
// listing, and the vendor's catalogue changes on model-release days, not
// between two requests.
const modelsCache = new Map<string, CacheEntry<Models>>()
// The daily call quota the vendor's ratelimit headers told, per token.
const callQuota = new Map<string, CacheEntry<CallQuota>>()
const nameCheckedAt = new Map<string, number>()
const peekedAt = new Map<string, number>()

// Built-in fallback, shown before sign-in and kept when /models can't be
// fetched. Every entry is probe-verified on the international site (a model
// listed by /v1/models isn't always routable or accessible — Ambassador-tier
// Qwen answers 403, some entries answer 400 "has no provider supported").
const FALLBACK_MODELS: Record<string, ModelSeed> = {
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
    name: "DeepSeek V4.1 Flash 1017",
    limit: { context: 1048576, output: 393216 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
  },
  "zai-org/GLM-5.2": {
    name: "GLM 5.2",
    limit: { context: 1048576, output: 131072 },
    reasoning: true,
    tool_call: true,
  },
  "deepseek-ai/DeepSeek-V4-Pro": {
    name: "DeepSeek V4 Pro",
    limit: { context: 1048576, output: 131072 },
    reasoning: true,
    tool_call: true,
  },
}

// The built-in list above is the pre-sign-in / fetch-failure fallback: flagship
// models only. Once an account signs in, the hook returns everything the vendor
// lists, unfiltered.

function envelopeData(payload: Envelope | null | undefined): Record<string, unknown> {
  const v = payload?.Data ?? payload?.data
  return v && typeof v === "object" ? v : {}
}

function envelopeMessage(payload: Envelope | null | undefined): string {
  return String(payload?.Message || payload?.message || payload?.msg || "").trim()
}

function envelopeOk(payload: Envelope | null | undefined): boolean {
  if (typeof payload?.Success === "boolean") return payload.Success
  if (typeof payload?.success === "boolean") return payload.success
  const code = payload?.Code ?? payload?.code
  if (code === undefined || code === null) return true
  return Number(code) === 200
}

function maskToken(token: unknown): string {
  const t = String(token || "")
  return t.length > 8 ? `${t.slice(0, 5)}…${t.slice(-3)}` : "ms-…"
}

function cached<T>(map: Map<string, CacheEntry<T>>, token: string, ttlMs: number): T | undefined {
  const hit = map.get(token)
  return hit && Date.now() - hit.at < ttlMs ? hit.value : undefined
}

function remember<T>(map: Map<string, CacheEntry<T>>, token: string, value: T): T {
  map.set(token, { at: Date.now(), value })
  prune(map)
  return value
}

function expiredError(what: string, status: number): Error & { signIn: "expired" } {
  return Object.assign(
    new Error(`${what}：令牌失效或不属于国际站（HTTP ${status}）`),
    { signIn: "expired" as const },
  )
}

// What an inference answer says about the sign-in, told to magpie explicitly:
// 401 is the token refused; 402/403/429 are credits, model access or a
// throttle, none of which means the sign-in is gone. Body and headers pass
// through untouched (the gateway promises no Retry-After, so backoff is
// magpie's own; magpie strips content-encoding and content-length itself,
// since fetch hands the body over decoded).
function withSignIn(res: Response, state: "expired" | "kept"): Response {
  const headers = new Headers(res.headers)
  headers.set("x-magpie-sign-in", state)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

// ModelScope grants magicubes once a Beijing day at check-in and they expire
// 24h after the grant, so an exhausted account has nothing until the next
// day's grant — magpie's generic 15-minute rest would just retry all day for
// nothing. The usage window below is how the account is held: magpie rests an
// account whose window is used up until its resetsAt (routing.go heldUp), and
// clears the rest once that passes. Next Beijing 00:35 leaves room for
// magpie's check-in loop (every 30 min) to press the day's grant.
function nextBeijingReset(now: number = Date.now()): string {
  const bj = now + 8 * 3600e3 // Beijing wall clock, read through UTC fields
  const d = new Date(bj)
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const wall = midnight + 35 * 60e3 // 00:35 Beijing, as a wall-clock epoch
  const target = wall <= bj ? wall + 86400e3 : wall // roll to tomorrow if past
  return new Date(target - 8 * 3600e3).toISOString() // back to a real instant
}

// The call quotas reset at Beijing midnight sharp. The window renews at the
// midnight whose five-minute guard is not yet past — a reading taken a
// minute after midnight holds for a minute, not a day — else at the next
// day's.
function nextBeijingCallReset(now: number = Date.now()): string {
  const bj = now + 8 * 3600e3 // Beijing wall clock, read through UTC fields
  const d = new Date(bj)
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const target = midnight + 5 * 60e3 > bj ? midnight : midnight + 86400e3
  return new Date(target - 8 * 3600e3 + 5 * 60e3).toISOString() // a real instant, +5 min
}

// The window that holds an exhausted account until the next grant. used:100
// with a future resetsAt is what magpie's heldUp reads to sit the account out;
// span >= 24h also feeds its autoReset path.
function exhaustedWindow(): UsageWindow[] {
  return [{ name: "魔粒", used: 100, span: 86400, resetsAt: nextBeijingReset(), display: "今日魔粒已用完" }]
}

// GET a web API with the m_session_id cookie. 401/403 mark the sign-in expired.
async function siteGet(path: string, token: string, what: string): Promise<Envelope> {
  const res = await fetch(SITE + path, {
    headers: { cookie: `m_session_id=${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (res.status === 401 || res.status === 403) throw expiredError(what, res.status)
  if (!res.ok) throw new Error(`${what}失败：HTTP ${res.status}`)
  let payload: Envelope = {}
  try {
    payload = (await res.json()) as Envelope
  } catch {}
  if (!envelopeOk(payload)) {
    throw new Error(`${what}失败：${envelopeMessage(payload) || "上游返回失败"}`)
  }
  return payload
}

// The ledger stamps rows with the vendor's Beijing day as gmt_created, so
// "today" is read from that date string — no local clock guesswork.
function beijingDay(now: number = Date.now()): string {
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 10)
}

type LedgerRecord = {
  type?: string
  rule_key?: string
  gmt_created?: string
  total_amount?: number | string
}

// What today's grant came to, read from the ledger: found when a daily rule
// paid today, with the credits it paid. null when the ledger can't be read —
// it is the check, not the trigger, so its failure isn't the check-in's.
async function dailyEarnings(
  token: string,
  day: string,
): Promise<{ found: boolean; credit: number } | null> {
  try {
    const payload = await siteGet(`${TXNS_PATH}?page=1&page_size=50`, token, "魔粒账单查询")
    const data = envelopeData(payload) as { records?: LedgerRecord[] }
    const rows = Array.isArray(data.records) ? data.records : []
    const today = rows.filter(
      (r) =>
        String(r?.type || "").toUpperCase() === "EARN" &&
        String(r?.gmt_created || "") === day &&
        DAILY_RULES.includes(String(r?.rule_key || "").toLowerCase()),
    )
    return {
      found: today.length > 0,
      credit: today.reduce((n, r) => n + (Number(r?.total_amount) || 0), 0),
    }
  } catch (err) {
    if ((err as { signIn?: string })?.signIn === "expired") throw err
    return null
  }
}

// login/info names the account; an api-type sign-in has no accountId of its
// own, so magpie would label it "API key …xxxx". Save the name (and the
// vendor's HavanaId as uid) back to the account so the picker shows the
// ModelScope user instead. Once, when it differs; a failure here never fails
// the check-in.
function firstText(d: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = d[key]
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim()
  }
  return ""
}

async function saveAccountName(
  client: PluginInput["client"],
  auth: Auth,
  payload: Envelope,
): Promise<void> {
  const data = envelopeData(payload)
  const name = firstText(data, ["NickName", "Name", "nickname", "name"])
  const uid = firstText(data, ["HavanaId"])
  if (!name || !client?.auth?.set) return
  if (name === String(auth.accountId ?? "") && uid === String(auth.uid ?? "")) return
  try {
    await client.auth.set({
      path: { id: PROVIDER },
      body: { ...auth, accountId: name, ...(uid ? { uid } : {}) },
    })
  } catch {}
}

// Accounts added before a check-in ran have no name yet; a usage read asks
// login/info once to name them, so the picker shows the user rather than
// "API key …xxxx". At most once per 10 minutes per account.
async function ensureName(
  client: PluginInput["client"],
  auth: Auth,
  token: string,
): Promise<void> {
  if (String(auth.accountId ?? "") || !client?.auth?.set) return
  const now = Date.now()
  if (now - (nameCheckedAt.get(token) || 0) < 10 * 60_000) return
  nameCheckedAt.set(token, now)
  pruneAt(nameCheckedAt)
  try {
    await saveAccountName(client, auth, await siteGet(LOGIN_INFO_PATH, token, "账号信息"))
  } catch {}
}

async function checkinImpl(auth: Auth | undefined, client?: PluginInput["client"]): Promise<CheckinResult> {
  const token = auth?.key
  if (!token) throw new Error("缺少 ModelScope 访问令牌")
  const day = beijingDay()
  // The login is the trigger; the ledger is the proof. Read it before so a
  // check-in already granted today answers done, not a false "claimed".
  const before = await dailyEarnings(token, day)
  if (before?.found) {
    await ensureName(client, auth, token) // name it even when the grant is in
    return before.credit
      ? { outcome: "done", credit: before.credit, message: `今日已领取 ${before.credit} 魔粒` }
      : { outcome: "done", message: "今日已领取" }
  }
  try {
    const payload = await siteGet(LOGIN_INFO_PATH, token, "每日签到")
    await saveAccountName(client, auth, payload)
  } catch (err) {
    const e = err as Error & { signIn?: string }
    if (e?.signIn === "expired") throw err
    return { outcome: "failed", message: e?.message || String(err) }
  }
  // The grant can land a moment after the login; one short retry settles it.
  let after = await dailyEarnings(token, day)
  if (before && !after?.found) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    after = await dailyEarnings(token, day)
  }
  if (after?.found) {
    return after.credit
      ? { outcome: "claimed", credit: after.credit, message: `签到到账 ${after.credit} 魔粒` }
      : { outcome: "claimed", message: "每日登录奖励已触发" }
  }
  return { outcome: "claimed", message: "每日登录奖励已触发" }
}

// The calls window: the account's daily API-call quota from the inference
// responses' ratelimit headers (all models together), reset at Beijing
// midnight. An exhausted one holds the account the same way an exhausted
// magicube balance does. A reading older than an hour isn't shown.
function callsWindow(quota: CallQuota | undefined, now: number = Date.now()): UsageWindow | undefined {
  if (!quota || !Number.isFinite(quota.limit) || quota.limit <= 0) return undefined
  if (now - quota.at > CALLS_KEEP_MS) return undefined
  const used = Math.min(quota.limit, Math.max(0, quota.limit - quota.remaining))
  return {
    name: "调用",
    used: (100 * used) / quota.limit,
    amount: used,
    limit: quota.limit,
    unit: "次",
    display: `${used} / ${quota.limit}`,
    span: 86400,
    resetsAt: nextBeijingCallReset(quota.at),
  }
}

// The card a usage read composes: the daily API-call window from the latest
// inference response's ratelimit headers, then the magicubes as a credits
// window — amount/limit/unit so the picker shows real numbers (236/350), and
// used 100 with a future resetsAt once they are spent, which is what magpie's
// heldUp reads to sit the account out until the next grant. total_balance is
// what the live cubes granted, available_balance what is left of them.
function usageCard(
  available: number,
  total: number,
  calls?: CallQuota,
): UsageCard {
  const card: UsageCard = { plan: "魔粒", windows: [] }
  const cw = callsWindow(calls)
  if (cw) card.windows.push(cw)
  if (!Number.isFinite(available)) return card
  card.balance = String(available)
  const granted = Number.isFinite(total) && total > 0 ? total : available > 0 ? available : 0
  if (granted <= 0) {
    card.windows.push(...exhaustedWindow()) // no live cubes: hold until the next grant
    return card
  }
  const used = Math.max(0, granted - available)
  card.windows.push({
    name: "魔粒",
    used: (100 * used) / granted,
    amount: used,
    limit: granted,
    unit: "魔粒",
    display: `${used} / ${granted}`,
    span: 86400,
    resetsAt: nextBeijingReset(),
  })
  return card
}

async function readCubes(token: string): Promise<{ available: number; total: number }> {
  const payload = await siteGet(BALANCE_PATH, token, "魔粒余额查询")
  const data = envelopeData(payload) as MagicubeData
  return { available: Number(data.available_balance), total: Number(data.total_balance) }
}

// The card is composed at read time, but the cache entry is the numbers, and
// its freshness is judged by what they say: a live balance can move on any
// request, an exhausted one moves only at the next grant — and when that
// grant lands, the check-in's ledger read drops the cache itself, so the
// longer exhausted TTL costs nothing.
function cubesFresh(cubes: { available: number; total: number }, at: number): boolean {
  const age = Date.now() - at
  return age < cubesTtl(cubes.available <= 0)
}

async function usageImpl(auth: Auth | undefined, client?: PluginInput["client"]): Promise<UsageCard> {
  const token = auth?.key
  if (!token) return { error: "缺少 ModelScope 访问令牌", windows: [] }
  try {
    let hit = cubesCache.get(token)
    if (!hit || !cubesFresh(hit.value, hit.at)) {
      const cubes = await readCubes(token)
      hit = { at: Date.now(), value: cubes }
      remember(cubesCache, token, cubes)
    }
    if (auth) await ensureName(client, auth, token)
    return usageCard(hit.value.available, hit.value.total, callQuota.get(token)?.value)
  } catch (err) {
    const e = err as Error & { signIn?: "expired" }
    if (e?.signIn === "expired") {
      return { error: e.message, signIn: "expired", windows: [] }
    }
    return { error: e?.message || String(err), windows: [] }
  }
}

// A 429 may be the vendor's RPM limit or the account out of cubes. A balance
// read tells them apart and refreshes the card — at most once a minute per
// account, so a burst of 429s doesn't hammer the web API, and off the
// response path: the 429 goes back the moment the status is known, the read
// settles the card behind it, and a failure in it is none of the request's.
function peekBalance(token: string): void {
  if (Date.now() - (peekedAt.get(token) || 0) < 60_000) return
  peekedAt.set(token, Date.now())
  pruneAt(peekedAt)
  readCubes(token)
    .then((cubes) => remember(cubesCache, token, cubes))
    .catch(() => {})
}

// The calls quota an inference response's ratelimit headers told. Both counts
// must be there; anything unreadable is ignored — the headers are a bonus,
// never a failure.
function noteCallQuota(token: string, res: Response): void {
  const limit = Number(res.headers.get("modelscope-ratelimit-requests-limit"))
  const remaining = Number(res.headers.get("modelscope-ratelimit-requests-remaining"))
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return
  remember(callQuota, token, { limit, remaining, at: Date.now() })
}

async function modelsImpl(
  provider: { models: Models },
  { auth }: { auth?: Auth } = {},
): Promise<Models> {
  if (auth?.type !== "api" || !auth.key) return provider.models
  // The vendor's catalogue changes on model-release days, not between two
  // requests, and the hook is asked on every listing: 10 minutes per account.
  const hit = modelsCache.get(auth.key)
  if (hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.value
  try {
    const res = await fetch(`${API_BASE}${MODELS_PATH}`, {
      headers: { authorization: `Bearer ${auth.key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) throw expiredError("模型列表", res.status)
    if (!res.ok) {
      console.log(`[modelscope] /models answered HTTP ${res.status}; keeping the built-in list`)
      return provider.models
    }
    const { data } = (await res.json()) as { data?: Array<{ id?: string }> }
    if (!Array.isArray(data) || data.length === 0) return provider.models
    const out = Object.fromEntries(
      data.filter((m) => typeof m.id === "string").map((m) => [m.id as string, modelEntry(m.id as string)]),
    ) as Models
    return remember(modelsCache, auth.key, out)
  } catch (err) {
    if ((err as { signIn?: string })?.signIn === "expired") throw err
    return provider.models
  }
}

// A model as magpie reads it — the full OpenCode shape, not the compact
// declaration: the models hook's entries are taken as they are, and a
// compact one lists the model as unable to reason, call tools or see images.
// A known id keeps its measured limits; an unknown one gets safe defaults.
function modelEntry(id: string): ModelEntry {
  const known = FALLBACK_MODELS[id]
  const input = { text: true, image: false, audio: false, video: false, pdf: false }
  for (const k of known?.modalities?.input ?? []) if (k in input) input[k as "image"] = true
  const output = { text: true, image: false, audio: false, video: false, pdf: false }
  return {
    id,
    providerID: PROVIDER,
    name: known?.name ?? id,
    api: { id, url: API_BASE, npm: SDK },
    status: "active",
    limit: known?.limit ?? { context: 128000, output: 8192 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, // served on the plan's magicubes
    options: {},
    headers: {},
    capabilities: {
      temperature: true,
      reasoning: known?.reasoning ?? false,
      attachment: input.image,
      toolcall: known?.tool_call ?? true,
      input,
      output,
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

export const ModelScopeAuthPlugin = async (input: PluginInput = {}) => {
  const client = input.client
  return ({
  config: async (cfg: PluginConfig) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "ModelScope",
      npm: SDK,
      api: API_BASE,
      models: FALLBACK_MODELS,
    }
  },

  auth: {
    provider: PROVIDER,
    icon: ICON,
    methods: [{ type: "api", label: "ModelScope 账号登录", placeholder: "ms-…" }],
    async loader(getAuth: GetAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      return {
        baseURL: API_BASE,
        async fetch(input: string | URL | Request, init?: RequestInit) {
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${auth.key}`)
          const res = await fetch(input, { ...init, headers })
          // The response's ratelimit headers are a free reading of the
          // account's daily call quota; they feed the usage card, and a
          // spent one holds the account until the vendor's midnight reset.
          noteCallQuota(auth.key, res)
          if (res.status === 401) return withSignIn(res, "expired")
          if (res.status === 403) return withSignIn(res, "kept") // model access, not the sign-in
          if (res.status === 402 || res.status === 429) {
            // Out of credits, or the gateway's throttle: drop the cached card
            // so the next usage read settles it (a 429 also gets one balance
            // read a minute to tell the two apart, off the response path).
            // magpie backs off; the 429 goes back now.
            if (res.status === 402) cubesCache.delete(auth.key)
            else peekBalance(auth.key)
            return withSignIn(res, "kept")
          }
          return res
        },
      }
    },
    usage: (getAuth: GetAuth) => getAuth().then((auth) => usageImpl(auth, client)),
    checkin: (getAuth: GetAuth) => getAuth().then((auth) => checkinImpl(auth, client)),
  },

  provider: {
    id: PROVIDER,
    models: modelsImpl,
  },
  })
}

// magpie calls every exported function of the entry module as a plugin;
// helpers live here so tests can reach them without becoming plugins.
export const _internal = {
  PROVIDER,
  API_BASE,
  SITE,
  LOGIN_INFO_PATH,
  BALANCE_PATH,
  TXNS_PATH,
  DAILY_RULES,
  MODELS_PATH,
  TIMEOUT_MS,
  FALLBACK_MODELS,
  cubesCache,
  modelsCache,
  callQuota,
  envelopeData,
  envelopeMessage,
  envelopeOk,
  maskToken,
  expiredError,
  beijingDay,
  dailyEarnings,
  nextBeijingReset,
  nextBeijingCallReset,
  exhaustedWindow,
  usageCard,
  callsWindow,
  cubesFresh,
  modelEntry,
  peekBalance,
  noteCallQuota,
  siteGet,
  checkinImpl,
  usageImpl,
  modelsImpl,
}
