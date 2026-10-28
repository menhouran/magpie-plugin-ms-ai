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
  // When the credits still in the window are lost, apart from its reset (the
  // vendor expires a day's grants 24 hours after they land), and how many.
  runsOutAt?: string
  runsOut?: number
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
  outcome: "claimed" | "done" | "failed" | "inactive"
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
  status: "active" | "deprecated" | "beta" | "alpha" | "legacy"
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
const USERS_ME_PATH = "/openapi/v1/users/me"
const BALANCE_PATH = "/openapi/v1/magicubes/balance"
const TXNS_PATH = "/openapi/v1/magicubes/transactions"
const MODELS_PATH = "/models"
// How long a web-API or /models call waits before it is given up on; a
// vendor that never answers must not park a quota read or a listing.
const TIMEOUT_MS = 20_000
// The rules that pay the daily grant; other EARN rows (invites, events) are
// not today's check-in.
const DAILY_RULES = ["daily_active", "aliyun_bindlogin"]
// The monochrome ModelScope mark (models.dev), inlined so it draws without
// outbound access; currentColor lets the window tint it.
const ICON =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCA0MCA0MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTYuNzc4MjUgMTAuNDk5OUgxNC4zMzMzVjE0LjI3ODJIMTAuNTU1MVYxOC4wNTVINi43NzgyNVYxNC45ODY1SDMuNzA4MzNWMTguMDU1SDYuNzc4MjVWMjEuODMzM0gzVjE0LjI3ODJINi43NzgyNVYxMC40OTk5Wk02Ljc3ODI1IDIxLjgzMzNIMTAuNTU1MVYyNS42MTE1SDE0LjMzMzNWMjkuMzg4NEg2Ljc3ODI1VjIxLjgzMzNaTTE0LjMzMzMgMTguMDU1SDE4LjExMTZWMjEuODMzM0gxNC4zMzMzVjE4LjA1NVpNMjEuODg4NCAyMS44MzMzVjI1LjYxMTVIMTguMTExNlYyMS44MzMzSDIxLjg4ODRaTTIxLjg4ODQgMjEuODMzM1YxOC4wNTVIMjUuNjY2N1YyMS44MzMzSDIxLjg4ODRaIiBmaWxsPSJjdXJyZW50Q29sb3IiLz4KPHBhdGggZD0iTTMzLjIyMTggMjEuODMzM1YxOC4wNTVIMjkuNDQ1VjE0LjI3ODJIMjUuNjY2N1YxMC40OTk5SDMzLjIyMThWMTQuMjc4MkgzNy4wMDAxVjIxLjgzMzNIMzMuMjIxOFpNMzMuMjIxOCAxOC4wNTVIMzYuMjkxOFYxNC45ODY1SDMzLjIyMThWMTguMDU1WiIgZmlsbD0iY3VycmVudENvbG9yIi8+CjxwYXRoIGQ9Ik0zMy4yMjE4IDIxLjgzMzNWMjkuMzg4NEgyNS42NjY3VjI1LjYxMTZIMjkuNDQ1VjIxLjgzMzNIMzMuMjIxOFoiIGZpbGw9ImN1cnJlbnRDb2xvciIvPgo8L3N2Zz4K"

// magpie schedules the check-in itself — once per account per Beijing day,
// a failure retried half an hour later — so the plugin adds no throttle or
// time gate of its own there; the vendor is idempotent anyway. The vendor's
// web API is read at most every half hour per account, and only when the card
// is actually asked for: between reads the numbers are estimated from the
// calls that went through this plugin, which is what keeps a quota page that
// refreshes constantly from hammering the vendor.
const USAGE_TTL_MS = 30 * 60 * 1000
// What one call is counted at between vendor reads: the top tier's price
// (flagship ~2 magicubes). Counting every call at the top price can only
// overstate the spend, never the balance left, which is the safe direction:
// the worst it does is ask the vendor a little early.
const CALL_COST = 2
// At or below this the estimate is no longer trusted and the next read goes to
// the vendor — two flagship calls' worth, the point where "nearly out" stops
// being something to guess at.
const SYNC_BELOW = 4
// The account's /v1/models list: the hook is asked on every listing, and the
// vendor's answer changes on model-release days, not between two requests.
const MODELS_TTL_MS = 30 * 60 * 1000
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

// The account's live numbers, per token, anchored on two independent vendor
// reads: the balance (what is left) and the day's ledger (what the day was
// made of). Each anchor is refreshed on its own clock — the balance every
// half hour and whenever the estimate says the account is nearly out; the
// ledger once a day and when the estimate says the day's grant is spent — so
// a card that is asked for constantly still costs at most one request per
// account per half hour, and usually one balance read and two ledger reads a
// day. Between reads the numbers are estimated from the calls this plugin
// saw go through, each counted at the top tier's price (flagship ~2), which
// can only overstate the spend and never the balance left: the safe way to
// be wrong.
type Live = {
  at: number // when the balance was read
  available: number
  total: number
  sinceBalance: number // calls seen since that read
  ledgerAt: number // when the ledger was read
  day: string // the Beijing day it covers
  ledger: DayLedger
  sinceLedger: number // calls seen since that read
}

const liveCache = new Map<string, Live>()

function noteCall(token: string): void {
  const live = liveCache.get(token)
  if (live) {
    live.sinceBalance++
    live.sinceLedger++
    return
  }
  // No anchor yet (nothing has been read, or the last read was dropped): count
  // on a stub so the first card after a burst still knows about those calls.
  const day = beijingDay()
  liveCache.set(token, {
    at: 0,
    available: NaN,
    total: NaN,
    sinceBalance: 1,
    ledgerAt: 0,
    day,
    ledger: { found: false, credit: 0, earned: 0, spent: 0, calls: 0 },
    sinceLedger: 0,
  })
  if (liveCache.size > STATE_MAX) {
    const keys = [...liveCache.keys()].slice(0, liveCache.size - STATE_MAX)
    for (const k of keys) liveCache.delete(k)
  }
}

function dropLive(token: string): void {
  liveCache.delete(token)
}

// The two anchors, brought up to date only as far as each needs. The balance:
// every half hour, and sooner when calls since its read brought the estimate
// nearly to zero (no calls since means the anchor is already the truth). The
// ledger: when the day turned, and when the estimate says the day's grant was
// spent — but never more than once every five minutes, so an exhausted day
// doesn't turn the card into a poll.
async function refreshLive(token: string): Promise<Live> {
  let live = liveCache.get(token)
  const now = Date.now()
  const day = beijingDay()
  if (live && live.day !== day) {
    // yesterday's ledger is yesterday's: don't let it answer for today
    live.ledger = { found: false, credit: 0, earned: 0, spent: 0, calls: 0 }
    live.day = day
    live.sinceLedger = 0
    live.ledgerAt = 0
  }
  const needBalance =
    !live || now - live.at >= USAGE_TTL_MS ||
    (live.sinceBalance > 0 && estLeft(live) <= SYNC_BELOW)
  if (needBalance) {
    const data = await readBalance(token)
    live = liveCache.get(token) ?? live ?? stubLive(day)
    live.at = now
    live.available = Number(data.available_balance)
    live.total = Number(data.total_balance)
    live.sinceBalance = 0
    liveCache.set(token, live)
  }
  if (!live) live = stubLive(day)
  const spentEst = live.ledger.spent + CALL_COST * live.sinceLedger
  const needLedger =
    !live.ledgerAt || (live.day === day && live.sinceLedger > 0 &&
      live.ledger.earned > 0 && spentEst >= live.ledger.earned &&
      now - live.ledgerAt > 5 * 60_000)
  if (needLedger) {
    const ledger = await dailyEarnings(token, day)
    live.ledger = ledger ?? live.ledger
    live.day = day
    live.ledgerAt = now
    live.sinceLedger = 0
  }
  liveCache.set(token, live)
  return live
}

function stubLive(day: string): Live {
  return {
    at: 0,
    available: NaN,
    total: NaN,
    sinceBalance: 0,
    ledgerAt: 0,
    day,
    ledger: { found: false, credit: 0, earned: 0, spent: 0, calls: 0 },
    sinceLedger: 0,
  }
}

// What the balance has left after the calls since its read.
function estLeft(live: Live): number {
  return Math.max(0, live.available - CALL_COST * live.sinceBalance)
}
// The account's own /v1/models answer, per token: the hook is asked on every
// listing, and the vendor's catalogue changes on model-release days, not
// between two requests.
const modelsCache = new Map<string, CacheEntry<Models>>()
const nameCheckedAt = new Map<string, number>()

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

// The window that holds an exhausted account until the next grant. used:100
// with a future resetsAt is what magpie's heldUp reads to sit the account out;
// span >= 24h also feeds its autoReset path.
function exhaustedWindow(): UsageWindow[] {
  return [{ name: "魔粒", used: 100, span: 86400, resetsAt: nextBeijingReset(), display: "今日魔粒已用完" }]
}

// GET a web API with the m_session_id cookie. 401 marks the sign-in expired.
// 403 does not: the vendor answers it as risk control, and the account is
// usually fine — marking it expired would send the user to re-login for a
// refused request (the same reading the community's msmoli plugin takes).
async function siteGet(
  path: string,
  token: string,
  what: string,
  auth: "cookie" | "bearer" = "cookie",
): Promise<Envelope> {
  const headers: Record<string, string> =
    auth === "bearer" ? { authorization: `Bearer ${token}` } : { cookie: `m_session_id=${token}` }
  const res = await fetch(SITE + path, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (res.status === 401) throw expiredError(what, res.status)
  if (res.status === 403) throw new Error(`${what}失败：被魔搭风控拒绝（HTTP 403）`)
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
  expire_at?: string
  count?: number | string
}

// The ledger stamps a time as the vendor's own clock reads it: "2026-10-29
// 01:02:24", Beijing wall time with a space, no zone. Date would read that as
// the host's local time — UTC on a server — so the expiry would land eight
// hours early. Read it as Beijing and hand magpie a real instant.
function vendorTime(value: unknown): string {
  const raw = String(value || "").trim()
  if (!raw) return ""
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) {
    const parsed = new Date(raw)
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString()
  }
  const [, y, mo, d, h, mi, s] = m
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h) - 8, // Beijing is UTC+8
    Number(mi),
    Number(s || "0"),
  )
  return Number.isNaN(utc) ? "" : new Date(utc).toISOString()
}

// The day's ledger, read once and answering both questions it holds. credit is
// what the daily rules paid (what a check-in reports); earned is every EARN row
// today, promotions included (what the card's limit is — leaving promotions out
// would show "earned 0" while the balance rose); reset is the earliest expiry
// among today's daily grants, which is when the hold should end. null when the
// ledger can't be read — it is the check, not the trigger, so its failure isn't
// the check-in's. Paged past the first sheet: billing is per call, so a busy day
// files today's few EARN rows behind hundreds of spends, and a first page that
// no longer reaches them would read today's grant as zero.
const LEDGER_PAGE = 100
const LEDGER_PAGES = 3

type DayLedger = {
  found: boolean
  credit: number
  earned: number
  spent: number
  calls: number
  reset?: string
}

async function dailyEarnings(token: string, day: string): Promise<DayLedger | null> {
  let found = false
  let credit = 0
  let earned = 0
  let spent = 0
  let calls = 0
  let reset: string | undefined
  try {
    for (let page = 1; page <= LEDGER_PAGES; page++) {
      const payload = await siteGet(
        `${TXNS_PATH}?page=${page}&page_size=${LEDGER_PAGE}`,
        token,
        "魔粒账单查询",
      )
      const data = envelopeData(payload) as { records?: LedgerRecord[] }
      const rows = Array.isArray(data.records) ? data.records : []
      for (const r of rows) {
        if (String(r?.gmt_created || "") !== day) continue
        const type = String(r?.type || "").toUpperCase()
        const amount = Number(r?.total_amount) || 0
        if (type === "EARN") {
          earned += amount
          if (DAILY_RULES.includes(String(r?.rule_key || "").toLowerCase())) {
            found = true
            credit += amount
            const expire = vendorTime(r?.expire_at)
            if (expire && (!reset || expire < reset)) reset = expire
          }
        } else if (type === "SPEND_CONFIRM" || type === "SPEND") {
          // The ledger's own figure for what today's calls confirm; refunds
          // land as negative rows, so the sum can dip below zero. count is how
          // many calls the row covers — one row can be a whole batch.
          spent += amount
          calls += Number(r?.count) || 0
        }
        // EXPIRE is its own row: magicubes that ran out unused were taken
        // back, not spent. Counting them as use would report a day's use as
        // what the account actually burned.
      }
      // The ledger lists newest first: a short page is the end of the list, and
      // a last row already before today means today's block ended here.
      if (rows.length < LEDGER_PAGE) break
      const last = String(rows[rows.length - 1]?.gmt_created || "")
      if (last && last < day) break
    }
    // A sum of decimals read as floats: 0.1 + 0.2 is 0.30000000000000004,
    // and it would go into the card as written.
    return {
      found,
      credit,
      earned: Math.round(earned * 100) / 100,
      spent: Math.round(spent * 100) / 100,
      calls,
      ...(reset ? { reset } : {}),
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

// Accounts added before a check-in ran have no name yet; a usage read names
// them once, so the picker shows the user rather than "API key …xxxx". The
// name comes from the published /openapi/v1/users/me (bearer, no side effect);
// the website's login/info is the fallback, and it grants the day's magicubes
// as a side effect, so it is asked second and only when the official one says
// nothing. At most once per 10 minutes per account.
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
    const me = await siteGet(USERS_ME_PATH, token, "账号信息", "bearer")
    const data = envelopeData(me)
    const name = firstText(data, ["username", "Username", "NickName", "nickname", "name"])
    if (name) {
      await saveAccountName(client, auth, { Data: { NickName: name } })
      return
    }
  } catch {}
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
    dropLive(token) // the grant is in: the card's numbers are stale
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
    dropLive(token) // the grant landed: the next card read sees it
    return after.credit
      ? { outcome: "claimed", credit: after.credit, message: `签到到账 ${after.credit} 魔粒` }
      : { outcome: "claimed", message: "每日登录奖励已触发" }
  }
  // A ledger that answers but shows no grant today: the login reached the
  // vendor and nothing came of it — say so instead of claiming a credit that
  // may not exist (the account may be out of the programme). One that can't
  // be read at all is a different thing: the grant may be on its way, so
  // let magpie ask again.
  if (after) return { outcome: "inactive", message: "登录已触达，但今天没有到账记录" }
  return { outcome: "failed", message: "签到已触发，但账单查询失败，稍后会自动重试" }
}

// The card a usage read composes: the magicubes as a credits window —
// amount/limit/unit so the picker shows real numbers (20/250), and used 100
// with a future resetsAt once they are spent, which is what magpie's heldUp
// reads to sit the account out until the next grant. limit is what the day
// brought in (every EARN row, community rewards included — leaving those out
// would read "earned 0" while the balance rose), used is what the ledger says
// today's calls confirm. Billing is per-call magicubes (light ~0.5, standard
// ~1, flagship ~2), so this window IS the allowance; the vendor stopped
// publishing a per-day count. total_balance is available + frozen (the
// vendor's own words), so it is not the day's allowance and can't be the
// window's limit.
function usageCard(
  available: number,
  earned: number,
  spent: number,
  runsOut?: string,
  calls?: number,
): UsageCard {
  const card: UsageCard = { plan: "魔粒", windows: [] }
  if (!Number.isFinite(available)) return card
  card.balance = String(available)
  const limit = Number.isFinite(earned) && earned > 0 ? earned : 0
  if (limit <= 0) {
    // Nothing came in today: the balance is all there is to say, and a window
    // of 0/0 would be a made-up number.
    if (available <= 0) card.windows.push(...exhaustedWindow())
    return card
  }
  // What today cost, from the ledger's own rows (refunds land as negative
  // SPEND_CONFIRM, so the sum can dip below zero). A charge freezes the
  // balance before the ledger confirms it, so the balance's own shortfall
  // catches what is still in flight; the larger of the two never understates,
  // and the percentage is held below 100 while anything is left — magpie's
  // heldUp (routing.go) stops an account whenever a window reads 100 and no
  // model, without looking at the balance, so a day that spent past its own
  // grants — out of long-term magicubes, which expire in 90 days — must not
  // park an account that can still serve.
  const used = Math.max(0, spent, limit - available)
  const pct = (100 * used) / limit
  // runsOutAt is when the day's credits are lost, apart from the reset: the
  // vendor expires the daily grants 24 hours after they land, so a balance sat
  // on is gone — that is a different time from the reset, and magpie draws
  // them differently. runsOut is how much of the day's grant is still unspent,
  // which is what that expiry takes away.
  const runsOutAt = runsOut && new Date(runsOut).getTime() > Date.now() ? runsOut : ""
  const unspent = Math.max(0, limit - used)
  card.windows.push({
    name: "魔粒",
    used: available <= 0 ? 100 : Math.min(pct, 99),
    amount: used,
    limit,
    unit: "魔粒",
    // the calls behind the spend, when the ledger counted them: a call costs
    // 0.5 to 2 magicubes by tier, so the count is what the day's spend was
    // made of, and the two are different questions.
    display: calls ? `${used} / ${limit} · ${calls} 次调用` : `${used} / ${limit}`,
    span: 86400,
    resetsAt: nextBeijingReset(),
    ...(runsOutAt && unspent > 0 ? { runsOutAt, runsOut: unspent } : {}),
  })
  return card
}

// The Magicube balance is the one web read with a published contract:
// https://www.modelscope.ai/.well-known/openapi.json, tag Magicube,
// GET /magicubes/balance (server https://modelscope.ai/openapi/v1), and it
// takes the access token as bearerAuth. The website's session cookie answers
// the same path, so a vendor that drops either one leaves the other: bearer
// first, since that is the documented way, cookie as the fallback.
async function readBalance(token: string): Promise<MagicubeData> {
  try {
    return envelopeData(await siteGet(BALANCE_PATH, token, "魔粒余额查询", "bearer")) as MagicubeData
  } catch (err) {
    if ((err as { signIn?: string })?.signIn !== "expired") throw err
    return envelopeData(await siteGet(BALANCE_PATH, token, "魔粒余额查询", "cookie")) as MagicubeData
  }
}

// The Magicube balance is the one web read with a published contract:

async function usageImpl(auth: Auth | undefined, client?: PluginInput["client"]): Promise<UsageCard> {
  const token = auth?.key
  if (!token) return { error: "缺少 ModelScope 访问令牌", windows: [] }
  try {
    // Two anchors, each asked only when its own clock says so: the balance
    // for what is left, the ledger for what the day was made of. Between
    // their reads the card runs on the calls this plugin saw, so a page that
    // refreshes every minute costs no request at all.
    const live = await refreshLive(token)
    if (auth) await ensureName(client, auth, token)
    const spent = live.ledger.spent + CALL_COST * live.sinceLedger
    const calls = live.ledger.calls + live.sinceLedger
    return usageCard(estLeft(live), live.ledger.earned, spent, live.ledger.reset, calls)
  } catch (err) {
    const e = err as Error & { signIn?: "expired" }
    if (e?.signIn === "expired") {
      return { error: e.message, signIn: "expired", windows: [] }
    }
    return { error: e?.message || String(err), windows: [] }
  }
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
    const { data } = (await res.json()) as { data?: Array<{ id?: string; created?: number }> }
    if (!Array.isArray(data) || data.length === 0) return provider.models
    const out = Object.fromEntries(
      data.filter((m) => typeof m.id === "string").map((m) => [m.id as string, modelEntry(m.id as string, m.created)]),
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
// The vendor's catalogue gives a name only as an id ("deepseek-ai/DeepSeek-
// V4.1-Flash"), so the display name is read off it, and created is the
// release date magpie sorts by.
function modelEntry(id: string, created?: number): ModelEntry {
  const known = FALLBACK_MODELS[id]
  const input = { text: true, image: false, audio: false, video: false, pdf: false }
  for (const k of known?.modalities?.input ?? []) if (k in input) input[k as "image"] = true
  const output = { text: true, image: false, audio: false, video: false, pdf: false }
  return {
    id,
    providerID: PROVIDER,
    name: known?.name ?? displayName(id),
    api: { id, url: API_BASE, npm: SDK },
    status: DEPRECATED_MODELS.some((p) => id.startsWith(p)) ? "deprecated" : "active",
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
    release_date: releaseDate(created),
    variants: {},
  }
}

// The vendor's own ids, read as names: "deepseek-ai/DeepSeek-V4.1-Flash-1017"
// is "DeepSeek V4.1 Flash 1017". The dates on them (0813, 1017) are release
// stamps, not part of the name, so they are kept but set apart.
function displayName(id: string): string {
  const tail = id.split("/").pop() || id
  return tail
    .replace(/[-_]/g, " ")
    .replace(/\b(\d{4})$/, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

// Models the vendor lists but a plan can't call: the Ambassador tier answers
// 403 (measured on the vendor's own catalogue), so it is marked deprecated and
// magpie keeps it out of the picker.
const DEPRECATED_MODELS = ["Qwen-Ambassador/"]

// The vendor's created stamp is a Unix time in seconds; magpie wants a date.
function releaseDate(created?: number): string {
  if (!created || !Number.isFinite(created)) return ""
  const d = new Date(created * 1000)
  if (Number.isNaN(d.getTime())) return ""
  return d.toISOString().slice(0, 10)
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
          // What an answer means for the sign-in: 401 is the token refused.
          // 402 is the account out of magicubes — drop the cached card so the
          // next usage read holds the account at once; 403 is model access
          // and 429 the gateway's throttle, neither of which the sign-in is.
          // The answers themselves pass through; magpie backs off.
          // An answer the vendor served costs magicubes, so it moves the
          // estimate between vendor reads; a refused one doesn't.
          if (res.status === 200) noteCall(auth.key)
          if (res.status === 401) return withSignIn(res, "expired")
          if (res.status === 403) return withSignIn(res, "kept") // model access, not the sign-in
          if (res.status === 402) {
            dropLive(auth.key)
            return withSignIn(res, "kept")
          }
          if (res.status === 429) return withSignIn(res, "kept")
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
  LEDGER_PAGE,
  CALL_COST,
  SYNC_BELOW,
  USAGE_TTL_MS,
  liveCache,
  modelsCache,
  noteCall,
  estLeft,
  refreshLive,
  dropLive,
  vendorTime,
  USERS_ME_PATH,
  MODELS_TTL_MS,
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
  modelEntry,
  siteGet,
  checkinImpl,
  usageImpl,
  modelsImpl,
}
