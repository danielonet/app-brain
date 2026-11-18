/**
 * Embeddings from any server that speaks the OpenAI `/embeddings` protocol (Ollama, LM Studio, llama.cpp, vLLM, OpenAI).
 * Plain fetch, no dependency. Only symbol names, signatures and doc comments are sent, never a function body.
 */
export class EmbeddingError extends Error {
  constructor(message: string, readonly kind: "network" | "auth" | "model" | "bad_response" | "timeout") {
    super(message);
  }
}

export interface EmbeddingOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

const BATCH = 32;

export class OpenAiEmbeddings {
  constructor(private readonly opts: EmbeddingOptions) {}

  get model() { return this.opts.model; }
  get baseUrl() { return this.opts.baseUrl; }

  /** One unit vector per text, in order. Throws EmbeddingError with a message a person can act on. */
  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH) out.push(...(await this.batch(texts.slice(i, i + BATCH), signal)));
    return out;
  }

  private async batch(input: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.opts.model, input }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (timeout.aborted) throw new EmbeddingError(`${this.opts.baseUrl} took too long to answer.`, "timeout");
      throw new EmbeddingError(`Could not reach ${this.opts.baseUrl}: ${(e as Error).message}`, "network");
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new EmbeddingError(`${this.opts.baseUrl} refused the request (${res.status}).`, "auth");
      if (res.status === 404 || /not found|pull/i.test(text)) throw new EmbeddingError(`The server does not have the model “${this.opts.model}”. Pull or load it first.`, "model");
      throw new EmbeddingError(`${this.opts.baseUrl}/embeddings answered ${res.status}. ${text}`.trim(), "bad_response");
    }
    const body = (await res.json().catch(() => null)) as { data?: { index?: number; embedding?: unknown }[] } | null;
    const rows = body?.data;
    if (!Array.isArray(rows) || rows.length !== input.length) throw new EmbeddingError("The server's answer did not hold one embedding per text.", "bad_response");
    const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((r) => {
      const v = r.embedding;
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) throw new EmbeddingError("The server returned an embedding that is not a list of numbers.", "bad_response");
      return unit(Float32Array.from(v as number[]));
    });
  }
}

/** Scaled to length 1, so the dot product of two vectors is their cosine similarity. */
export function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
