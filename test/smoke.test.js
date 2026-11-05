// Drives the language server over stdio the way Zed does.
// Run with: bun test   (from the extension directory)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "bun-lint-lsp-"));
writeFileSync(
  join(root, "eslint.config.mjs"),
  `export default [{ files: ["**/*.js"], rules: { "no-console": "error", "prefer-const": "error", "no-unused-vars": "error" } }];\n`,
);
writeFileSync(join(root, "package.json"), `{ "name": "fixture", "private": true }\n`);

const fileUri = pathToFileURL(join(root, "src", "example.js")).href;
const source = 'let greeting = "héllo";\nconsole.log(greeting);\nlet unused = 1;\n';

let server;
let nextId = 1;
const waiting = new Map();
const notifications = [];
let notificationListeners = [];

function send(message) {
  const json = JSON.stringify({ jsonrpc: "2.0", ...message });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  server.stdin.flush();
}

function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

function nextNotification(method) {
  const existing = notifications.findIndex((message) => message.method === method);
  if (existing !== -1) return Promise.resolve(notifications.splice(existing, 1)[0].params);
  return new Promise((resolve) => notificationListeners.push({ method, resolve }));
}

async function readMessages() {
  let buffer = Buffer.alloc(0);
  for await (const chunk of server.stdout) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString())[1]);
      if (buffer.length < headerEnd + 4 + length) break;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      buffer = buffer.subarray(headerEnd + 4 + length);

      if (message.method && message.id !== undefined) {
        // A request from the server, such as workspace/configuration
        send({ id: message.id, result: [{ run: "onType", debounce: 0 }] });
      } else if (message.method) {
        const listener = notificationListeners.find((l) => l.method === message.method);
        if (listener) {
          notificationListeners = notificationListeners.filter((l) => l !== listener);
          listener.resolve(message.params);
        } else notifications.push(message);
      } else {
        const pending = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    }
  }
}

beforeAll(async () => {
  server = Bun.spawn([process.execPath, join(import.meta.dir, "..", "server", "bun-lint-lsp.js"), "--stdio"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  readMessages();
  const result = await request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    workspaceFolders: [{ uri: pathToFileURL(root).href, name: "fixture" }],
    capabilities: {},
  });
  expect(result.capabilities.codeActionProvider.codeActionKinds).toContain("source.fixAll.bunlint");
  send({ method: "initialized", params: {} });
  send({ method: "textDocument/didOpen", params: { textDocument: { uri: fileUri, languageId: "javascript", version: 1, text: source } } });
});

afterAll(async () => {
  await request("shutdown");
  send({ method: "exit" });
  await server.exited;
  rmSync(root, { recursive: true, force: true });
});

test("publishes diagnostics for the open buffer", async () => {
  const { uri, diagnostics } = await nextNotification("textDocument/publishDiagnostics");
  expect(uri).toBe(fileUri);
  const byRule = Object.fromEntries(diagnostics.map((d) => [d.code, d]));
  expect(Object.keys(byRule).sort()).toEqual(["no-console", "no-unused-vars", "prefer-const"]);
  expect(byRule["no-console"]).toMatchObject({
    severity: 1,
    source: "bun lint",
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 11 } },
    codeDescription: { href: "https://eslint.org/docs/latest/rules/no-console" },
  });
});

test("offers quick fixes for the problem under the cursor", async () => {
  const actions = await request("textDocument/codeAction", {
    textDocument: { uri: fileUri },
    range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
    context: { diagnostics: [] },
  });
  const titles = actions.map((a) => a.title);
  expect(titles).toContain("Fix this prefer-const problem");
  expect(titles).toContain("Disable prefer-const for this line");
  expect(titles).toContain("Disable prefer-const for the entire file");
  expect(titles).toContain("Fix all auto-fixable problems");
  expect(titles.some((t) => t.includes("no-console"))).toBe(false);

  const fix = actions.find((a) => a.title === "Fix this prefer-const problem");
  expect(fix.edit.changes[fileUri]).toEqual([
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 23 } }, newText: 'const greeting = "héllo";' },
  ]);
});

test("returns source.fixAll.bunlint for format on save", async () => {
  const actions = await request("textDocument/codeAction", {
    textDocument: { uri: fileUri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    context: { diagnostics: [], only: ["source.fixAll.bunlint"] },
  });
  expect(actions).toHaveLength(1);
  expect(actions[0].kind).toBe("source.fixAll.bunlint");
  expect(actions[0].edit.changes[fileUri]).toEqual([
    { range: { start: { line: 0, character: 0 }, end: { line: 2, character: 2 } }, newText: "const greeting = \"héllo\";\nconsole.log(greeting);\ncons" },
  ]);
});

test("re-lints after an edit", async () => {
  send({
    method: "textDocument/didChange",
    params: { textDocument: { uri: fileUri, version: 2 }, contentChanges: [{ text: 'export const greeting = "hi";\n' }] },
  });
  const { diagnostics, version } = await nextNotification("textDocument/publishDiagnostics");
  expect(version).toBe(2);
  expect(diagnostics).toEqual([]);
});

test("formatting applies every fix", async () => {
  send({
    method: "textDocument/didChange",
    params: { textDocument: { uri: fileUri, version: 3 }, contentChanges: [{ text: "let a = 1;\nexport { a };\n" }] },
  });
  const edits = await request("textDocument/formatting", { textDocument: { uri: fileUri }, options: { tabSize: 2, insertSpaces: true } });
  expect(edits).toEqual([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "cons" }]); // the shared trailing "t" is kept
});

test("clears diagnostics when the buffer closes", async () => {
  await nextNotification("textDocument/publishDiagnostics"); // from the version 3 change
  send({ method: "textDocument/didClose", params: { textDocument: { uri: fileUri } } });
  const { diagnostics } = await nextNotification("textDocument/publishDiagnostics");
  expect(diagnostics).toEqual([]);
});
