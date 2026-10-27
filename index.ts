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
  signIn?: "expired"
}

type CheckinResult = {
  outcome: "claimed" | "failed"
  message?: string
  credit?: number
  streak?: number
}

type ModelEntry = {
  id?: string
  name: string
  limit: { context: number; output: number }
  reasoning?: boolean
  tool_call?: boolean
  modalities?: { input: string[]; output: string[] }
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
// Overridable for tests and exotic deployments (the raccoon plugin's pattern).
const API_BASE = (process.env.MODELSCOPE_API_BASE || "https://api-inference.modelscope.ai/v1").replace(/\/+$/, "")
const SITE = (process.env.MODELSCOPE_SITE_URL || "https://www.modelscope.ai").replace(/\/+$/, "")
const LOGIN_INFO_PATH = "/api/v1/users/login/info"
const BALANCE_PATH = "/openapi/v1/magicubes/balance"
const TXNS_PATH = "/openapi/v1/magicubes/transactions"
const MODELS_PATH = "/models"
// The rules that pay the daily grant; other EARN rows (invites, events) are
// not today's check-in.
const DAILY_RULES = ["daily_active", "aliyun_bindlogin"]
// The monochrome ModelScope mark (models.dev), inlined so it draws without
// outbound access.
const ICON =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCA0MCA0MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTYuNzc4MjUgMTAuNDk5OUgxNC4zMzMzVjE0LjI3ODJIMTAuNTU1MVYxOC4wNTVINi43NzgyNVYxNC45ODY1SDMuNzA4MzNWMTguMDU1SDYuNzc4MjVWMjEuODMzM0gzVjE0LjI3ODJINi43NzgyNVYxMC40OTk5Wk02Ljc3ODI1IDIxLjgzMzNIMTAuNTU1MVYyNS42MTE1SDE0LjMzMzNWMjkuMzg4NEg2Ljc3ODI1VjIxLjgzMzNaTTE0LjMzMzMgMTguMDU1SDE4LjExMTZWMjEuODMzM0gxNC4zMzMzVjE4LjA1NVpNMjEuODg4NCAyMS44MzMzVjI1LjYxMTVIMTguMTExNlYyMS44MzMzSDIxLjg4ODRaTTIxLjg4ODQgMjEuODMzM1YxOC4wNTVIMjUuNjY2N1YyMS44MzMzSDIxLjg4ODRaIiBmaWxsPSJjdXJyZW50Q29sb3IiLz4KPHBhdGggZD0iTTMzLjIyMTggMjEuODMzM1YxOC4wNTVIMjkuNDQ1VjE0LjI3ODJIMjUuNjY2N1YxMC40OTk5SDMzLjIyMThWMTQuMjc4MkgzNy4wMDAxVjIxLjgzMzNIMzMuMjIxOFpNMzMuMjIxOCAxOC4wNTVIMzYuMjkxOFYxNC45ODY1SDMzLjIyMThWMTguMDU1WiIgZmlsbD0iY3VycmVudENvbG9yIi8+CjxwYXRoIGQ9Ik0zMy4yMjE4IDIxLjgzMzNWMjkuMzg4NEgyNS42NjY3VjI1LjYxMTZIMjkuNDQ1VjIxLjgzMzNIMzMuMjIxOFoiIGZpbGw9ImN1cnJlbnRDb2xvciIvPgo8L3N2Zz4K"

// magpie schedules the check-in itself — once per account per Beijing day,
// a failure retried half an hour later — so the plugin adds no throttle or
// time gate of its own there; the vendor is idempotent anyway. The balance
// read is cached 10 minutes per account so the quota page doesn't hammer the
// vendor's web API on every refresh.
const USAGE_TTL_MS = 10 * 60 * 1000
const usageCache = new Map<string, CacheEntry<UsageCard>>()

// Built-in fallback, shown before sign-in and kept when /models can't be
// fetched. Every entry is probe-verified on the international site (a model
// listed by /v1/models isn't always routable or accessible — Ambassador-tier
// Qwen answers 403, some entries answer 400 "has no provider supported").
const FALLBACK_MODELS: Models = {
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
  "nex-agi/Nex-N2.5-Pro": {
    name: "Nex N2.5 Pro",
    limit: { context: 262144, output: 235929 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
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
// magpie's own).
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

// The window that holds an exhausted account until the next grant. used:100
// with a future resetsAt is what magpie's heldUp reads to sit the account out;
// span >= 24h also feeds its autoReset path.
function exhaustedWindow(): UsageWindow[] {
  return [{ name: "魔粒", used: 100, span: 86400, resetsAt: nextBeijingReset(), display: "今日魔粒已用完" }]
}

// GET a web API with the m_session_id cookie. 401/403 mark the sign-in expired.
async function siteGet(path: string, token: string, what: string): Promise<Envelope> {
  const res = await fetch(SITE + path, { headers: { cookie: `m_session_id=${token}` } })
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
const nameCheckedAt = new Map<string, number>()
async function ensureName(
  client: PluginInput["client"],
  auth: Auth,
  token: string,
): Promise<void> {
  if (String(auth.accountId ?? "") || !client?.auth?.set) return
  const now = Date.now()
  if (now - (nameCheckedAt.get(token) || 0) < 10 * 60_000) return
  nameCheckedAt.set(token, now)
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
    return { outcome: "done", credit: before.credit || undefined, message: `今日已领取 ${before.credit} 魔粒` }
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
    return {
      outcome: "claimed",
      credit: after.credit || undefined,
      message: after.credit ? `签到到账 ${after.credit} 魔粒` : "每日登录奖励已触发",
    }
  }
  return { outcome: "claimed", message: "每日登录奖励已触发" }
}

// The card from a balance read: magicubes as a credits window, the shape the
// community plugins report (minimax's creditsWindow) — amount/limit/unit so
// the picker shows real numbers (236/350), and used 100 with a future
// resetsAt once they are spent, which is what magpie's heldUp reads to sit
// the account out until the next grant. total_balance is what the live cubes
// granted, available_balance what is left of them.
function usageCard(available: number, total: number): UsageCard {
  const card: UsageCard = { plan: "魔粒", windows: [] }
  if (!Number.isFinite(available)) return card
  card.balance = String(available)
  const granted = Number.isFinite(total) && total > 0 ? total : available > 0 ? available : 0
  if (granted <= 0) {
    card.windows = exhaustedWindow() // no live cubes: hold until the next grant
    return card
  }
  const used = Math.max(0, granted - available)
  card.windows = [{
    name: "魔粒",
    used: (100 * used) / granted,
    amount: used,
    limit: granted,
    unit: "魔粒",
    display: `${used} / ${granted}`,
    span: 86400,
    resetsAt: nextBeijingReset(),
  }]
  return card
}

async function usageImpl(auth: Auth | undefined, client?: PluginInput["client"]): Promise<UsageCard> {
  const token = auth?.key
  if (!token) return { error: "缺少 ModelScope 访问令牌", windows: [] }
  const hit = cached(usageCache, token, USAGE_TTL_MS)
  if (hit) return hit
  try {
    const payload = await siteGet(BALANCE_PATH, token, "魔粒余额查询")
    const data = envelopeData(payload) as MagicubeData
    if (auth) await ensureName(client, auth, token)
    return remember(usageCache, token, usageCard(Number(data.available_balance), Number(data.total_balance)))
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
// account, so a burst of 429s doesn't hammer the web API. The 429 itself
// goes back as it came either way.
const peekedAt = new Map<string, number>()
async function peekBalance(token: string): Promise<void> {
  if (Date.now() - (peekedAt.get(token) || 0) < 60_000) return
  peekedAt.set(token, Date.now())
  try {
    const payload = await siteGet(BALANCE_PATH, token, "魔粒余额查询")
    const data = envelopeData(payload) as MagicubeData
    remember(usageCache, token, usageCard(Number(data.available_balance), Number(data.total_balance)))
  } catch {}
}

async function modelsImpl(
  provider: { models: Models },
  { auth }: { auth?: Auth } = {},
): Promise<Models> {
  if (auth?.type !== "api" || !auth.key) return provider.models
  const base = (id: string): ModelEntry => {
    const known = FALLBACK_MODELS[id]
    if (!known) return { id, name: id, limit: { context: 128000, output: 8192 }, tool_call: true }
    return { ...known, id, name: known.name }
  }
  try {
    const res = await fetch(`${API_BASE}${MODELS_PATH}`, {
      headers: { authorization: `Bearer ${auth.key}` },
    })
    if (res.status === 401 || res.status === 403) throw expiredError("模型列表", res.status)
    if (!res.ok) {
      console.log(`[modelscope] /models answered HTTP ${res.status}; keeping the built-in list`)
      return provider.models
    }
    const { data } = (await res.json()) as { data?: Array<{ id?: string }> }
    if (!Array.isArray(data) || data.length === 0) return provider.models
    return Object.fromEntries(
      data.filter((m) => typeof m.id === "string").map((m) => [m.id, base(m.id as string)]),
    ) as Models
  } catch (err) {
    if ((err as { signIn?: string })?.signIn === "expired") throw err
    return provider.models
  }
}

export const ModelScopeAuthPlugin = async (input: PluginInput = {}) => {
  const client = input.client
  return ({
  config: async (cfg: PluginConfig) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "ModelScope",
      npm: "@ai-sdk/openai-compatible",
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
          if (res.status === 401) return withSignIn(res, "expired")
          if (res.status === 403) return withSignIn(res, "kept") // model access, not the sign-in
          if (res.status === 402 || res.status === 429) {
            // Out of credits, or the gateway's throttle: drop the cached card
            // so the next usage read settles it (a 429 also gets one balance
            // read a minute to tell the two apart). magpie backs off.
            if (res.status === 402) usageCache.delete(auth.key)
            else await peekBalance(auth.key)
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
  FALLBACK_MODELS,
  envelopeData,
  envelopeMessage,
  envelopeOk,
  maskToken,
  expiredError,
  beijingDay,
  dailyEarnings,
  nextBeijingReset,
  exhaustedWindow,
  usageCard,
  peekBalance,
  siteGet,
  checkinImpl,
  usageImpl,
  modelsImpl,
}