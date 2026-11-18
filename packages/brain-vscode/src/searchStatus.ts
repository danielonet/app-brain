import type { EmbeddingStatus } from "@app-brain/brain-protocol";

/** Pure (no `vscode` import) so what is sent to the server, and what is said back, is tested. */
export interface SearchSettings { model: string; baseUrl: string }

/** What the server is told. An empty model turns semantic search off; an empty URL means the usual local one. */
export function embeddingsInput(s: SearchSettings): { model: string; baseUrl: string } {
  return { model: s.model.trim(), baseUrl: s.baseUrl.trim() };
}

export interface SearchReport {
  level: "ok" | "working" | "off" | "error";
  text: string;
}

export function searchReport(e: EmbeddingStatus | undefined): SearchReport {
  if (!e) return { level: "off", text: "This server does not offer semantic search. Update the extension." };
  switch (e.state) {
    case "off":
      return { level: "off", text: "Semantic search is off. Search finds names and words only. Set “brain.search.embeddings.model” to an embedding model your local server runs (for example nomic-embed-text in Ollama) to also find code by meaning." };
    case "building":
      return { level: "working", text: `Semantic search is getting ready: ${e.done} of ${e.total} symbols done with ${e.model}. Searches use words only until some are done.` };
    case "ready":
      return { level: "ok", text: `Semantic search is on: ${e.done} symbols searchable by meaning with ${e.model} at ${e.endpoint}.` };
    case "error":
      return { level: "error", text: `Semantic search could not run: ${e.message}` };
  }
}
