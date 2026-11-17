import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { detectAgents, resolveAutoMode } from "../agentDetect";

const vscodeApp = "Visual Studio Code";
describe("auto mode", () => {
  it("uses the editor's language model when there is one", () => {
    const r = resolveAutoMode({ lmModels: 2, appName: vscodeApp, extensionIds: ["GitHub.copilot-chat"] });
    assert.equal(r.mode, "vscode-lm");
    assert.deepEqual(r.agents, ["GitHub Copilot"]);
  });
  it("falls back to the connected agent: Claude Code, which offers no editor model", () => {
    const r = resolveAutoMode({ lmModels: 0, appName: vscodeApp, extensionIds: ["anthropic.claude-code"] });
    assert.equal(r.mode, "agent");
    assert.deepEqual(r.agents, ["Claude Code"]);
  });
  it("detects Cursor by the app name", () => {
    assert.deepEqual(detectAgents({ lmModels: 0, appName: "Cursor", extensionIds: [] }), ["Cursor"]);
  });
  it("never picks local or api-key on its own: with nothing found it stays agent and says where to go", () => {
    const r = resolveAutoMode({ lmModels: 0, appName: vscodeApp, extensionIds: [] });
    assert.equal(r.mode, "agent");
    assert.deepEqual(r.agents, []);
    assert.match(r.reason, /LLM settings/);
  });
});
