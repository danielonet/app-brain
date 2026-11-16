import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { DaemonInfo, daemonHealthy, readDaemonInfo, runtimeDir } from "@app-brain/brain-protocol";
import type { BrainWorkspace } from "./workspace";

/** The running daemon for this workspace, if there is one serving the same output folder. */
export async function findLiveDaemon(ws: BrainWorkspace, env: NodeJS.ProcessEnv = process.env): Promise<DaemonInfo | null> {
  const info = await readDaemonInfo(runtimeDir(ws.root, env));
  if (!info || info.workspace !== ws.root || info.outputDir !== ws.outputDir) return null;
  return (await daemonHealthy(info)) ? info : null;
}

const isRequest = (m: JSONRPCMessage): m is JSONRPCMessage & { id: string | number; method: string } => "method" in m && "id" in m;

/**
 * Forwards an agent's stdio connection to the daemon, message for message. The agent keeps a stable config
 * (a command, no token, no port); the daemon does the work once, for everyone. The agent connects with the
 * agent token only, so it gets the read-only tools and can never use the admin ones.
 */
export function runProxy(info: DaemonInfo, log: (line: string) => void): Promise<void> {
  const stdio = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { authorization: `Bearer ${info.agentToken}` } } });
  return new Promise<void>((resolve) => {
    let done = false;
    let watchdog: NodeJS.Timeout | undefined;
    const finish = (why: string) => {
      if (done) return;
      done = true;
      if (watchdog) clearInterval(watchdog);
      log(why);
      // End the daemon's session properly (the protocol's DELETE) so it does not wait for a timeout to notice we left.
      const bye = Promise.race([remote.terminateSession().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
      void bye.then(() => Promise.allSettled([stdio.close(), remote.close()])).then(() => resolve());
    };
    stdio.onmessage = (m) => {
      remote.send(m).catch((e: Error) => {
        log(`could not reach the daemon: ${e.message}`);
        if (isRequest(m)) void stdio.send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: `The brain daemon is unreachable: ${e.message}` } });
        finish("daemon unreachable");
      });
    };
    remote.onmessage = (m) => {
      // The HTTP transport must send the negotiated protocol version on every later request.
      const result = (m as { result?: { protocolVersion?: string; serverInfo?: unknown } }).result;
      if (result?.protocolVersion && result.serverInfo) remote.setProtocolVersion(result.protocolVersion);
      void stdio.send(m);
    };
    stdio.onclose = () => finish("agent disconnected");
    remote.onclose = () => finish("daemon connection closed");
    stdio.onerror = (e) => log(`stdio error: ${e.message}`);
    remote.onerror = (e) => log(`daemon connection error: ${e.message}`);
    // The agent leaving shows up as stdin ending, which StdioServerTransport does not report by itself.
    process.stdin.on("end", () => finish("agent disconnected"));
    process.stdin.on("close", () => finish("agent disconnected"));
    // The HTTP stream quietly retries when the daemon dies, so ask the daemon directly. Two misses in a row means it is gone,
    // and the agent is better off with a closed connection (it restarts us, and we find the new daemon or run alone).
    let misses = 0;
    watchdog = setInterval(() => {
      void daemonHealthy(info, 1000).then((ok) => {
        misses = ok ? 0 : misses + 1;
        if (misses >= 2) finish("the daemon stopped answering");
      });
    }, 2000);
    watchdog.unref();
    void remote.start().then(() => stdio.start());
  });
}
