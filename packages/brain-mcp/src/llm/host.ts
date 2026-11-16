import type { Reach } from "@app-brain/brain-protocol";

/**
 * Who can see what is sent to this URL. "Local" model settings are just a URL, and a URL can point at another
 * machine or the internet; the interface must not say "nothing leaves this machine" for those.
 */
export function classifyHost(url: string): { reach: Reach; host: string; encrypted: boolean } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const encrypted = u.protocol === "https:";
  // The whole address must be a loopback one: "127.0.0.1.evil.com" starts with 127. but is somebody else's server.
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::ffff:127.0.0.1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return { reach: "this-machine", host, encrypted };
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const priv = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    return { reach: priv ? "local-network" : "internet", host, encrypted };
  }
  if (host.includes(":")) return { reach: /^(fe80|fc|fd)/.test(host) ? "local-network" : "internet", host, encrypted }; // IPv6 literal
  if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal") || host.endsWith(".home.arpa") || !host.includes(".")) return { reach: "local-network", host, encrypted }; // single-label names resolve inside a network
  return { reach: "internet", host, encrypted };
}

/** A sentence about where the code goes, for the confirmation dialog. */
export function reachWarning(url: string): { text: string; reach: Reach } {
  const c = classifyHost(url);
  if (!c) return { text: `The model URL (${url}) is not a valid URL.`, reach: "internet" };
  if (c.reach === "this-machine") return { text: "Runs on this machine; nothing leaves it.", reach: c.reach };
  if (c.reach === "local-network") return { text: `Sends your source code to ${c.host} on your network${c.encrypted ? "" : ", unencrypted"}.`, reach: c.reach };
  return { text: `Sends your source code over the internet to ${c.host}${c.encrypted ? "" : ", UNENCRYPTED"}. This is not a local model.`, reach: c.reach };
}

/** Which well-known server this looks like, to give a useful hint when it is not answering. */
export function guessServer(url: string): "ollama" | "lm-studio" | "llama-cpp" | null {
  const port = (() => { try { return new URL(url).port; } catch { return ""; } })();
  return port === "11434" ? "ollama" : port === "1234" ? "lm-studio" : port === "8080" ? "llama-cpp" : null;
}
