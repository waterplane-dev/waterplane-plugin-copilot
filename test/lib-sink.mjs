/** A loopback HTTP sink standing in for the daemon's /api/plugin/copilot/hook. */
import { createServer } from "node:http";

export async function startSink(answer = () => ({})) {
  const posts = [];
  const waiters = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", async () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      posts.push(body);
      for (const w of [...waiters]) if (w.pred(body)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(body); }
      const out = await answer(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/plugin/copilot/hook`;
  return {
    url, posts,
    /** Resolve with the first post (past or future) matching `pred`. */
    waitFor(pred, ms = 10000) {
      const hit = posts.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`no matching post within ${ms} ms; got ${JSON.stringify(posts.map((p) => p?.hook))}`)), ms).unref();
      });
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
