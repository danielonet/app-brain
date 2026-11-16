import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  AdminTools,
  BrainStatus,
  ENV_ADMIN_TOKEN,
  HelloResult,
  InitResult,
  PROTOCOL_VERSION,
  ReindexResult,
  Resources,
  UsageSummary,
} from "@app-brain/brain-protocol";
import type { ConnState } from "./format";

export interface BrainClientOptions {
  nodePath: string;
  serverPath: string;
  workspace: string;
  outputDir: string;
  log: (line: string) => void;
  onState: (state: ConnState, status: BrainStatus | null) => void;
  onUsage?: (usage: UsageSummary) => void;
}

export interface SearchHit {
  symbol: string;
  kind: string;
  path: string;
  lines: string;
  signature: string;
  doc: string | null;
}

/**
 * The extension's only door to the server: a plain MCP client (PLAN-VSCODE-EXTENSION.md §2).
 * No indexing or file logic lives here.
 */
export class BrainClient {
  private client: Client | null = null;
  private status: BrainStatus | null = null;
  private stopping = false;
  private restarts = 0;
  private readonly token = randomUUID();

  constructor(private readonly opts: BrainClientOptions) {}

  get current(): BrainStatus | null {
    return this.status;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.opts.onState("connecting", null);
    try {
      const transport = new StdioClientTransport({
        command: this.opts.nodePath,
        args: [this.opts.serverPath, "--workspace", this.opts.workspace, "--output-dir", this.opts.outputDir],
        env: { ...getDefaultEnvironment(), [ENV_ADMIN_TOKEN]: this.token },
        stderr: "pipe",
      });
      const client = new Client({ name: "brain-vscode", version: "0.0.0" });
      transport.stderr?.on("data", (b: Buffer) => this.opts.log(b.toString().trimEnd()));
      client.onclose = () => void this.onClosed(client);
      client.onerror = (e) => this.opts.log(`client error: ${e.message}`);
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        if (n.params.uri === Resources.status) void this.refresh();
        else if (n.params.uri === Resources.usage) void this.refreshUsage();
      });
      await client.connect(transport);
      this.client = client;

      const hello = await this.call<HelloResult>(AdminTools.hello, {
        adminToken: this.token,
        client: "brain-vscode",
        protocolVersion: PROTOCOL_VERSION,
      });
      if (!hello.admin) throw new Error("Server refused the admin handshake.");
      await client.subscribeResource({ uri: Resources.status });
      await client.subscribeResource({ uri: Resources.usage });
      this.restarts = 0;
      await this.refresh();
      await this.refreshUsage();
    } catch (e) {
      this.opts.log(`start failed: ${(e as Error).message}`);
      await this.teardown();
      this.opts.onState("failed", null);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.teardown();
    this.status = null;
    this.opts.onState("disconnected", null);
  }

  private async teardown() {
    const c = this.client;
    this.client = null;
    if (c) {
      c.onclose = undefined;
      await c.close().catch(() => {});
    }
  }

  /** Restart with backoff, three tries, then surface an error (plan §6 step 6). */
  private async onClosed(closed: Client) {
    if (this.stopping || this.client !== closed) return;
    this.client = null;
    this.status = null;
    if (this.restarts >= 3) {
      this.opts.onState("failed", null);
      return;
    }
    const delay = 500 * 2 ** this.restarts++;
    this.opts.log(`server exited; restarting in ${delay}ms (attempt ${this.restarts}/3)`);
    this.opts.onState("connecting", null);
    await new Promise((r) => setTimeout(r, delay));
    if (!this.stopping) await this.start();
  }

  async refresh(): Promise<void> {
    if (!this.client) return;
    const res = await this.client.readResource({ uri: Resources.status });
    this.status = JSON.parse((res.contents[0] as { text: string }).text) as BrainStatus;
    this.opts.onState("connected", this.status);
  }

  async refreshUsage(): Promise<void> {
    if (!this.client || !this.opts.onUsage) return;
    const res = await this.client.readResource({ uri: Resources.usage });
    this.opts.onUsage(JSON.parse((res.contents[0] as { text: string }).text) as UsageSummary);
  }

  /** Symbol search for the quick pick. Calls made as "brain-vscode" are not counted as agent usage. */
  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const r = await this.call<{ results: SearchHit[] }>("search_code", { query, limit });
    return r.results;
  }

  private async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) throw new Error("Brain server is not running.");
    const res = (await this.client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const body = JSON.parse(res.content[0].text);
    if (res.isError) throw new Error(body.error ?? "Tool call failed");
    return body as T;
  }

  initialise(): Promise<InitResult> {
    return this.call<InitResult>(AdminTools.init);
  }
  reindex(): Promise<ReindexResult> {
    return this.call<ReindexResult>(AdminTools.reindex);
  }
}
