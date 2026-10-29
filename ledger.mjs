/**
 * What Copilot spent, in its OWN unit (`TokenSource`), served at
 * `GET /api/tokenstats/copilot`.
 *
 *   createLedger({ home, otelDir, tail }) → { ledger(maxAgeMs): Promise<BackendTokensDoc> }
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
 * the session id, or whose spans name it), and of those only the checkpoints from the plugin's
 * first launch on — a plain-terminal session resumed here brings no older terminal spend.
 * Checkpoints of plain-terminal sessions in the same ~/.copilot are not counted, so `unit` and
 * `kinds` describe the same sessions. A `/fork` copies the parent's checkpoints (same event ids,
 * same running totals) into its own log: each checkpoint counts once, and the copies only seed
 * the fork's running total. A session whose checkpoints are all in the other unit (premium
 * requests after credits were seen) has no spend `unit` can hold, so it is not in `sessions`
 * unless its spans put it there — the document has one unit and no field to name the rest.
 *
 * Spans older than otel.mjs's SPAN_KEEP_MS (50 days) are not kept, so a day before that
 * carries credits only; a span file's name still marks its session as launched here.
 *
 * Tokens are not credits and credits are not tokens: `kinds` holds only tokens
 * (absent from a day or model no span covers), `unit` holds only the credits.
 * Nothing readable ⇒ `available:false` with a sentence, never zeros.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { drain, follow, tick } from "./jsonl.mjs";
import { createOtelReader } from "./otel.mjs";
import { SESSION_ID_RE } from "./paths.mjs";

const localDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const localHour = (t) => { const d = new Date(t); d.setMinutes(0, 0, 0); return d.getTime(); };
const HOURLY_KEEP_MS = 45 * 24 * 3_600_000;
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

export function createLedger({ home, otelDir, tail, now = Date.now } = {}) {
  // one 1 MiB window per synchronous step: a long first read yields to the event loop between
  // windows (see catchUp), and every file is read to its end before the doc is built
  const otel = createOtelReader(otelDir, { tail, now, maxWindows: 1 });
  /** events.jsonl path → { tail, id, checkpoints[], starts[] } (starts: session.start/resume times) */
  const sessions = new Map();
  let cached = null, pending = null;

  async function scanSessions() {
    const root = join(home, "session-state");
    let ids;
    try { ids = readdirSync(root); } catch { return false; }
    for (const id of ids) {
      if (!SESSION_ID_RE.test(id)) continue;
      const p = join(root, id, "events.jsonl");
      let s = sessions.get(p);
      if (!s) {
        const checkpoints = [], starts = [];
        s = {
          id: id.toLowerCase(), dir: id, checkpoints, starts,
          tail: follow(tail, p, (e) => {
            const at = Date.parse(e?.timestamp);
            if (!Number.isFinite(at)) return;
            if (e.type === "session.start" || e.type === "session.resume") { starts.push(at); return; }
            if (e.type !== "session.usage_checkpoint") return;
            const nano = e.data?.totalNanoAiu, pr = e.data?.totalPremiumRequests;
            checkpoints.push({ at, id: typeof e.id === "string" ? e.id : null, nano: Number.isFinite(nano) && nano >= 0 ? nano : null, pr: Number.isFinite(pr) && pr >= 0 ? pr : null });
          }, { filter: (l) => l.includes('"session.usage_checkpoint"') || l.includes('"session.start"') || l.includes('"session.resume"'), onReset: () => { checkpoints.length = 0; starts.length = 0; }, maxWindows: 1 }),
        };
        sessions.set(p, s);
      }
      if (await drain(s.tail)) await tick();
    }
    // a conversation removed from disk is gone from the ledger now, as it is after a restart
    for (const [p, s] of sessions) if (!ids.includes(s.dir)) { s.tail.close(); sessions.delete(p); }
    return true;
  }

  /**
   * Read every session log and span file to its end first, never a partial first scan: a
   * doc stamped `scannedAt: now()` must not undercount, and "no usage yet" must not be said
   * while a long log is still unread. Synchronous reads go 1 MiB at a time between yields, so
   * a first scan of a large ~/.copilot does not hold the event loop (or a caller's timeout).
   */
  async function build() {
    const haveEvents = await scanSessions();
    const haveOtel = await otel.catchUp();
    const chats = otel.all();
    const sessionIds = new Set();
    // ONE population for the whole doc: the sessions this plugin launched. Only those have an OTel
    // file (launch.mjs sets COPILOT_OTEL_FILE_EXPORTER_PATH per launch, named for the session id, or
    // `continue-*` with the id inside the spans). Credits from `session.usage_checkpoint` live in
    // EVERY ~/.copilot session, including ones started at a plain terminal; counting those next to
    // tokens that never saw them would put two populations in one document.
    const fileIds = new Set(otel.fileIds());
    const launched = new Set(fileIds);
    // a conversation's earliest span ever read, kept past the 50-day span eviction: otherwise a
    // launch's old spend would be cut once its first span aged out and a later resume came first
    const firstSpan = otel.firsts();
    for (const id of firstSpan.keys()) launched.add(id);
    for (const c of chats) if (c.conv) launched.add(c.conv);
    // From when a launched session counts: the session.start/resume this plugin's launch wrote,
    // i.e. the latest one at or before the launch's first span (a span ends before its turn's
    // checkpoint), or before the OTel file's birth when no span names the id yet. Earlier
    // checkpoints are a plain terminal's (or, in a fork, the parent's copies): not counted, but
    // they seed the running total so the first counted delta is this launch's own.
    const countFrom = (s) => {
      let at = firstSpan.get(s.id), bySpan = at != null;
      if (!bySpan && fileIds.has(s.id)) {
        try { const st = statSync(join(otelDir, `${s.id}.jsonl`)); at = Math.min(st.birthtimeMs > 0 ? st.birthtimeMs : Infinity, st.mtimeMs); } catch { at = null; }
      }
      if (at == null) return -Infinity;
      let start = null;
      for (const t of s.starts) if (t <= at && (start == null || t > start)) start = t;
      return start ?? (bySpan ? at : -Infinity); // no start event known: a file's time is too loose to cut on
    };

    // credits (or premium requests) per local day, from checkpoint deltas
    const perDay = {}, turnsDay = {}, unitHour = new Map();
    let credits = 0, creditSeen = false, premium = 0, premiumSeen = false, creditTurns = 0;
    let first = null, last = null;
    const stamp = (t) => { if (t != null) { first = first == null ? t : Math.min(first, t); last = last == null ? t : Math.max(last, t); } };
    const ours = [];
    for (const s of sessions.values()) if (s.checkpoints.length && launched.has(s.id)) ours.push({ s, from: countFrom(s) });
    const nanoUsed = ours.some(({ s, from }) => s.checkpoints.some((c) => c.at >= from && c.nano != null));
    const counted = new Set(); // checkpoint event ids already counted: a fork's copies of its parent's
    for (const { s, from } of ours) {
      let prev = 0;
      for (const c of s.checkpoints.slice().sort((a, b) => a.at - b.at)) {
        const total = nanoUsed ? (c.nano != null ? c.nano / 1e9 : null) : c.pr;
        if (total == null) continue;
        const delta = total >= prev ? total - prev : total; // a counter that went down restarted
        prev = total;
        if (c.at < from || (c.id && counted.has(c.id))) continue;
        if (c.id) counted.add(c.id);
        sessionIds.add(s.id);
        const day = localDay(c.at);
        perDay[day] = (perDay[day] ?? 0) + delta;
        if (c.at != null) { const h = localHour(c.at); unitHour.set(h, (unitHour.get(h) ?? 0) + delta); }
        turnsDay[day] = (turnsDay[day] ?? 0) + 1;
        creditTurns++;
        if (nanoUsed) { credits += delta; creditSeen = true; } else { premium += delta; premiumSeen = true; }
        stamp(c.at);
      }
    }

    // tokens per day and model, from the chat spans
    const tot = {}, days = new Map(), models = new Map();
    const kindsHour = new Map();
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
      if (c.at != null) {
        const h = localHour(c.at);
        const hk = kindsHour.get(h) ?? kindsHour.set(h, {}).get(h);
        for (const [n, v] of Object.entries(k)) add(hk, n, v);
      }
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
    // hourly: the same bucket as localDay, ascending, only active hours, at most 45 days kept
    const cutHour = localHour(now() - HOURLY_KEEP_MS);
    const hours = [...new Set([...kindsHour.keys(), ...(unitName ? unitHour.keys() : [])])].filter((h) => h >= cutHour).sort((a, b) => a - b);
    // nothing in the last 45 days is still hours: `from` = the cut and no rows, so a span reads
    // "nothing ran", not "keeps its ledger by day"
    const hourly = {
      from: !hours.length || Math.min(...[...kindsHour.keys(), ...(unitName ? unitHour.keys() : [])]) < cutHour ? cutHour : hours[0],
      rows: hours.map((hour) => ({
        hour, kinds: kindsHour.get(hour) ?? {},
        ...(unitName && unitHour.has(hour) ? { unit: round(unitHour.get(hour)) } : {}),
      })),
    };
    return {
      available: true,
      totals: { kinds: tot, turns: tokenCalls ? interactions.size : creditTurns },
      days: [...dayRows.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      models: [...models.values()].sort((a, b) => (b.kinds.output ?? 0) + (b.kinds.input ?? 0) - ((a.kinds.output ?? 0) + (a.kinds.input ?? 0))),
      sessions: sessionIds.size,
      ...(unitName ? { unit: { name: unitName, perDay: Object.fromEntries(Object.entries(perDay).map(([d, v]) => [d, round(v)])) } } : {}),
      ...(hourly ? { hourly } : {}),
      firstAt: first, lastAt: last, scannedAt: now(),
    };
  }

  return {
    async ledger(maxAgeMs = 0) {
      if (cached && now() - cached.at < maxAgeMs) return cached.doc;
      // concurrent asks share one scan: two would interleave on the same followers
      pending ??= build().then((doc) => { cached = { at: now(), doc }; return doc; }).finally(() => { pending = null; });
      return pending;
    },
  };
}
