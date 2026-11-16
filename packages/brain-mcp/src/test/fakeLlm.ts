import { createServer, type IncomingMessage, type Server } from "node:http";

export interface Recorded {
  n: number;
  path: string;
  headers: IncomingMessage["headers"];
  body: any;
  /** The client hung up before we answered (a cancelled request). */
  aborted: boolean;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  delayMs?: number;
}

export type Handler = (req: Recorded) => FakeReply | Promise<FakeReply>;

/** What the Anthropic Messages API returns on success. */
export const anthropicOk = (text: string, o: { in?: number; out?: number; model?: string; stop?: string; cacheRead?: number } = {}) => ({
  id: "msg_fake", type: "message", role: "assistant", model: o.model ?? "test-model",
  content: [{ type: "text", text }], stop_reason: o.stop ?? "end_turn", stop_sequence: null,
  usage: { input_tokens: o.in ?? 1000, output_tokens: o.out ?? 200, ...(o.cacheRead ? { cache_read_input_tokens: o.cacheRead } : {}) },
});

export const anthropicError = (status: number, type: string, message: string, headers: Record<string, string> = {}): FakeReply => ({
  status, headers, json: { type: "error", error: { type, message } },
});

export const openAiOk = (text: string, o: { in?: number; out?: number; model?: string; finish?: string; noUsage?: boolean } = {}) => ({
  id: "chatcmpl-fake", object: "chat.completion", model: o.model ?? "llama-test",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: o.finish ?? "stop" }],
  ...(o.noUsage ? {} : { usage: { prompt_tokens: o.in ?? 800, completion_tokens: o.out ?? 150 } }),
});

/** The text of the first user message, for handlers that answer according to what was asked. */
export const userText = (r: Recorded): string => {
  const m = r.body?.messages?.find((x: any) => x.role === "user");
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
};
export const systemText = (r: Recorded): string => {
  if (typeof r.body?.system === "string") return r.body.system;
  const sys = r.body?.messages?.find((x: any) => x.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
};

/** A doc in the format the generator asks for, naming the target found in the prompt. */
export const docFor = (r: Recorded, extra = ""): string => {
  const u = userText(r);
  const target = /^File: (.+?) \(/m.exec(u)?.[1] ?? /^Module: (.+)$/m.exec(u)?.[1] ?? "unknown";
  return `DESCRIPTION: Does ${target}.\n\n## Overview\n\nThis explains ${target} for another engineer, in enough words to be a real document.${extra}\n`;
};

export async function startFakeLlm(initial: Handler): Promise<{ url: string; requests: Recorded[]; setHandler(h: Handler): void; close(): Promise<void> }> {
  let handler = initial;
  const requests: Recorded[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
    const rec: Recorded = { n: requests.length + 1, path: req.url ?? "", headers: req.headers, body, aborted: false };
    requests.push(rec);
    res.on("close", () => { if (!res.writableEnded) rec.aborted = true; });
    const reply = await handler(rec);
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (rec.aborted || res.destroyed) return;
    res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...(reply.headers ?? {}) });
    res.end(JSON.stringify(reply.json ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler: (h) => { handler = h; },
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
