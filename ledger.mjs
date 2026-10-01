/**
 * What Copilot spent, in its OWN unit (`TokenSource`), served at
 * `GET /api/tokenstats/copilot`.
 *
 *   createLedger({ home, otelDir }) → { ledger(maxAgeMs): Promise<BackendTokensDoc> }
 *
 * Two measured sources, never blended into one number:
 * - `session.usage_checkpoint` in each `events.jsonl` (once per prompt, after
 *   `agentStop`): `totalNanoAiu` is the RUNNING session total, so AI credits =
 *   totalNanoAiu / 1e9 (0.2234 / 0.2596 / 0.5478 matched the TUI footer).
 *   Per-checkpoint spend is the delta from the previous one; a total that went
 *   DOWN is a counter that restarted, so the new total is the spend. On the
 *   legacy billing platform there is no nano total and `totalPremiumRequests`
 *   is the unit instead ("premium requests") — never both in one `unit`.
 * - the OTel `chat` spans (otel.mjs): tokens per model call. `input_tokens` is
 *   the whole prompt, so the kinds are split the way Copilot's own
 *   `session.shutdown.tokenDetails` splits them: input (uncached) = input −
 *   cacheRead − cacheWrite, cacheRead, cacheWrite, output. A call whose cache
 *   fields exceed its input keeps `input` as reported rather than a negative.
 *
 * ONE population: only sessions this plugin launched (those with an OTel file, named for
 * the session id, or whose spans name it). Checkpoints of plain-terminal sessions in the same
 * ~/.copilot are not counted, so `unit` and `kinds` describe the same sessions.
 *
 * Tokens are not credits and credits are not tokens: `kinds` holds only tokens
 * (absent from a day or model no span covers), `unit` holds only the credits.
 * Nothing readable ⇒ `available:false` with a sentence, never zeros.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createTail } from "./tail.mjs";
import { createOtelReader } from "./otel.mjs";
import { SESSION_ID_RE } from "./paths.mjs";

const localDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const add = (m, k, v) => { if (v) m[k] = (m[k] ?? 0) + v; };

/** The token kinds of one chat span, Copilot's own split. */
export function kindsOf(c) {
  if (c.input == null && c.output == null) return null;
  const cr = c.cacheRead ?? 0, cw = c.cacheWrite ?? 0;
  const raw = c.input ?? 0;
  const k = {};
  k.input = raw - cr - cw >= 0 ? raw - cr - cw : raw;
  if (cr) k.cacheRead = cr;
  if (cw) k.cacheWrite = cw;
  k.output = c.output ?? 0;
  return k;
}

export function createLedger({ home, otelDir, now = Date.now } = {}) {
  const otel = createOtelReader(otelDir);
  /** events.jsonl path → { tail, id, checkpoints[] } */
  const sessions = new Map();
  let cached = null;

  function scanSessions() {
    const root = join(home, "session-state");
    let ids;
    try { ids = readdirSync(root); } catch { return false; }
    for (const id of ids) {
      if (!SESSION_ID_RE.test(id)) continue;
      const p = join(root, id, "events.jsonl");
      let s = sessions.get(p);
      if (!s) {
        const checkpoints = [];
        s = {
          id: id.toLowerCase(), checkpoints,
          tail: createTail(p, (e) => {
            if (e?.type !== "session.usage_checkpoint") return;
            const at = Date.parse(e.timestamp);
            const nano = e.data?.totalNanoAiu, pr = e.data?.totalPremiumRequests;
            if (Number.isFinite(at)) checkpoints.push({ at, nano: Number.isFinite(nano) && nano >= 0 ? nano : null, pr: Number.isFinite(pr) && pr >= 0 ? pr : null });
          }, { filter: (l) => l.includes('"session.usage_checkpoint"') }),
        };
        sessions.set(p, s);
      }
      s.tail.advance(() => { s.checkpoints.length = 0; });
    }
    return true;
  }

  function build() {
    const haveEvents = scanSessions();
    const haveOtel = otel.refresh();
    const chats = otel.all();
    const sessionIds = new Set();
    // ONE population for the whole doc: the sessions this plugin launched. Only those have an OTel
    // file (launch.mjs sets COPILOT_OTEL_FILE_EXPORTER_PATH per launch, named for the session id, or
    // `continue-*` with the id inside the spans). Credits from `session.usage_checkpoint` live in
    // EVERY ~/.copilot session, including ones started at a plain terminal; counting those next to
    // tokens that never saw them would put two populations in one document.
    const launched = new Set(otel.fileIds());
    for (const c of chats) if (c.conv) launched.add(c.conv);

    // credits (or premium requests) per local day, from checkpoint deltas
    const perDay = {}, turnsDay = {};
    let credits = 0, creditSeen = false, premium = 0, premiumSeen = false, creditTurns = 0;
    let first = null, last = null;
    const stamp = (t) => { if (t != null) { first = first == null ? t : Math.min(first, t); last = last == null ? t : Math.max(last, t); } };
    const nanoUsed = [...sessions.values()].some((s) => launched.has(s.id) && s.checkpoints.some((c) => c.nano != null));
    const creditsByModel = new Map();
    for (const s of sessions.values()) {
      if (!s.checkpoints.length || !launched.has(s.id)) continue;
      sessionIds.add(s.id);
      let prev = 0;
      for (const c of s.checkpoints.slice().sort((a, b) => a.at - b.at)) {
        const total = nanoUsed ? (c.nano != null ? c.nano / 1e9 : null) : c.pr;
        if (total == null) continue;
        const delta = total >= prev ? total - prev : total; // a counter that went down restarted
        prev = total;
        const day = localDay(c.at);
        perDay[day] = (perDay[day] ?? 0) + delta;
        turnsDay[day] = (turnsDay[day] ?? 0) + 1;
        creditTurns++;
        if (nanoUsed) { credits += delta; creditSeen = true; } else { premium += delta; premiumSeen = true; }
        stamp(c.at);
      }
    }

    // tokens per day and model, from the chat spans
    const tot = {}, days = new Map(), models = new Map();
    const interactions = new Set(), dayInter = new Map(), modelInter = new Map();
    let tokenCalls = 0;
    for (const c of chats) {
      const k = kindsOf(c);
      if (!k) continue;
      tokenCalls++;
      if (c.conv) sessionIds.add(c.conv);
      const day = c.at != null ? localDay(c.at) : null;
      stamp(c.at);
      for (const [n, v] of Object.entries(k)) add(tot, n, v);
      const key = c.interaction ?? `call${tokenCalls}`;
      interactions.add(key);
      if (day) {
        const d = days.get(day) ?? { day, kinds: {}, turns: 0 };
        for (const [n, v] of Object.entries(k)) add(d.kinds, n, v);
        days.set(day, d);
        (dayInter.get(day) ?? dayInter.set(day, new Set()).get(day)).add(key);
      }
      const mk = c.model ?? "(unnamed model)";
      const m = models.get(mk) ?? { key: mk, label: mk, kinds: {}, turns: 0 };
      for (const [n, v] of Object.entries(k)) add(m.kinds, n, v);
      models.set(mk, m);
      (modelInter.get(mk) ?? modelInter.set(mk, new Set()).get(mk)).add(key);
    }
    for (const [day, d] of days) d.turns = dayInter.get(day).size;
    for (const [k, m] of models) m.turns = modelInter.get(k).size;

    if (!tokenCalls && !creditSeen && !premiumSeen) {
      const why = !haveEvents && !haveOtel
        ? `no Copilot state on this desktop: neither ${join(home, "session-state")} nor ${otelDir} exists yet`
        : "Copilot has recorded no usage yet: no usage checkpoint in its session logs and no model call in its telemetry files";
      return { available: false, reason: why };
    }

    // a credit day with no token span still gets a row, with kinds absent (empty): credits are not tokens
    const dayRows = new Map(days);
    for (const day of Object.keys(perDay)) if (!dayRows.has(day)) dayRows.set(day, { day, kinds: {}, turns: turnsDay[day] });
    const unitName = creditSeen ? "AI credits" : premiumSeen ? "premium requests" : null;
    const round = (v) => Math.round(v * 1e6) / 1e6;
    return {
      available: true,
      totals: { kinds: tot, turns: tokenCalls ? interactions.size : creditTurns },
      days: [...dayRows.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      models: [...models.values()].sort((a, b) => (b.kinds.output ?? 0) + (b.kinds.input ?? 0) - ((a.kinds.output ?? 0) + (a.kinds.input ?? 0))),
      sessions: sessionIds.size,
      ...(unitName ? { unit: { name: unitName, perDay: Object.fromEntries(Object.entries(perDay).map(([d, v]) => [d, round(v)])) } } : {}),
      firstAt: first, lastAt: last, scannedAt: now(),
    };
  }

  return {
    async ledger(maxAgeMs = 0) {
      if (cached && now() - cached.at < maxAgeMs) return cached.doc;
      const doc = build();
      cached = { at: now(), doc };
      return doc;
    },
  };
}
