// A stand-in for the bit of the Anthropic Messages API the hub's Assistant proxy uses (POST /v1/messages), the way
// stripe-mock.mjs stands in for Stripe. node:http only; no test spends money.
//
//   import { startAnthropicMock } from "./anthropic-mock.mjs";
//   const mock = await startAnthropicMock({ port: 0, key: "sk-ant-test-123", respond: (req) => "text" });
//   hub env: ANTHROPIC_API_BASE=mock.url, ANTHROPIC_API_KEY=sk-ant-test-123
//   node test/anthropic-mock.mjs     // ANTHROPIC_MOCK_PORT (3404), ANTHROPIC_MOCK_KEY
//
// The request must carry x-api-key (the one given, or any sk-ant-... when none is) and anthropic-version, a model id
// the mock knows (claude-sonnet-5-5, claude-haiku-4-5-20251001, claude-opus-5-5, claude-fable-5-1; override with
// `models`), max_tokens, and messages that start with a user turn. Answers { id, type: "message", role, model, content:
// [{ type: "text", text }], stop_reason, usage: { input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens } } with usage worked out from the text (4 characters a token, an image 1,640 tokens; a
// system block with cache_control is a cache write the first time the same text is seen and a cache read after).
// `respond(req)` gets { model, system (text), messages, maxTokens, hasImage, userText, headers } and returns a string,
// or { text, stopReason, status, body, delayMs }; with none, the answer is `MOCK ANSWER for <first 40 characters>`.
// Test hooks (no auth): GET /__requests (everything received, newest last), POST /__next { status, body?, delayMs?,
// text? } (the next call answers that, once, queued in order), DELETE /__state.
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODELS = ["claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-opus-5-5", "claude-fable-5-1"];
const tokens = (s) => Math.ceil(String(s ?? "").length / 4);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export async function startAnthropicMock({ port = 0, key = process.env.ANTHROPIC_MOCK_KEY ?? "", respond = null, models = MODELS } = {}) {
  const requests = [];
  const queue = [];
  const seenSystems = new Set();
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "request-id": `req_${crypto.randomBytes(6).toString("hex")}` });
    res.end(JSON.stringify(body));
  };
  const error = (res, status, type, message) => send(res, status, { type: "error", error: { type, message } });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__requests") return send(res, 200, requests);
    if (url.pathname === "/__state" && req.method === "DELETE") {
      requests.length = 0;
      queue.length = 0;
      seenSystems.clear();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__next" && req.method === "POST") {
      queue.push(JSON.parse((await readBody(req)) || "{}"));
      return send(res, 200, { ok: true, queued: queue.length });
    }
    if (url.pathname !== "/v1/messages" || req.method !== "POST") return error(res, 404, "not_found_error", "no such route");
    const given = req.headers["x-api-key"] ?? "";
    if (key ? given !== key : !/^sk-ant-/.test(given)) return error(res, 401, "authentication_error", "invalid x-api-key");
    if (!req.headers["anthropic-version"]) return error(res, 400, "invalid_request_error", "anthropic-version header is required");
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return error(res, 400, "invalid_request_error", "body isn't JSON");
    }
    if (!models.includes(body.model)) return error(res, 404, "not_found_error", `model: ${body.model}`);
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return error(res, 400, "invalid_request_error", "max_tokens: Field required");
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages[0].role !== "user") return error(res, 400, "invalid_request_error", "messages: first message must use the user role");
    const sysBlocks = typeof body.system === "string" ? [{ type: "text", text: body.system }] : (body.system ?? []);
    const system = sysBlocks.map((b) => b.text).join("\n");
    const last = body.messages[body.messages.length - 1];
    const parts = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
    const hasImage = parts.some((p) => p.type === "image");
    const userText = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    const rec = { model: body.model, system, systemCached: sysBlocks.some((b) => b.cache_control), messages: body.messages, maxTokens: body.max_tokens, hasImage, userText, headers: { "x-api-key": given, "anthropic-version": req.headers["anthropic-version"] } };
    requests.push(rec);

    let scripted = queue.shift();
    let answer = scripted;
    if (!answer) {
      const r = respond ? await respond(rec) : `MOCK ANSWER for ${userText.slice(0, 40)}`;
      answer = typeof r === "string" ? { text: r } : r;
    }
    if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
    if (answer.status && answer.status !== 200) return send(res, answer.status, answer.body ?? { type: "error", error: { type: "api_error", message: "mock failure" } });
    const text = answer.text ?? "";
    const cached = rec.systemCached && seenSystems.has(system);
    if (rec.systemCached) seenSystems.add(system);
    const sysTokens = tokens(system);
    const input = tokens(JSON.stringify(body.messages)) + (hasImage ? 1640 : 0);
    return send(res, 200, {
      id: `msg_${crypto.randomBytes(8).toString("hex")}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text }],
      stop_reason: answer.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: input + (rec.systemCached ? 0 : sysTokens),
        output_tokens: Math.max(1, tokens(text)),
        cache_read_input_tokens: cached ? sysTokens : 0,
        cache_creation_input_tokens: rec.systemCached && !cached ? sysTokens : 0,
      },
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const bound = server.address().port;
  return { port: bound, url: `http://127.0.0.1:${bound}`, requests, queue, close: () => new Promise((r) => server.close(() => r())) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startAnthropicMock({ port: Number(process.env.ANTHROPIC_MOCK_PORT) || 3404 })
    .then((m) => console.log(`anthropic mock on ${m.url}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
