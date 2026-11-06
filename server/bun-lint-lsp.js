// A small language server that runs `bun lint` on each buffer and reports the result.
//
// Launched by the Zed extension as `bun bun-lint-lsp.js --stdio`, using the project's
// bun. It has no dependencies. It lints the unsaved buffer text through
// `bun lint --stdin --stdin-filename <path> --format json`. The output is ESLint's JSON
// format, so the features match the ESLint integration:
//   - diagnostics as you type (or on save)
//   - quick fixes: the rule's fix, its suggestions, and disabling the rule for a line or file
//   - "Fix all auto-fixable problems", as the `source.fixAll.bunlint` code action
//     (for format-on-save) and as document formatting
//
// Settings are read from `lsp.bun-lint.settings` in Zed:
//   run            "onType" (default) or "onSave"
//   debounce       milliseconds to wait after a change before linting (default 200)
//   quiet          report errors only (default false)
//   typeAware      also run the rules that need types (default false)
//   extraArgs      more arguments for every `bun lint` run (default [])
//   workingDirectory  directory to run `bun lint` from. By default this is the nearest
//                     folder above the file with a lint config or package.json, inside the workspace

import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "bun lint";
const FIX_ALL_KIND = "source.fixAll.bunlint";
const CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".oxlintrc.json",
  "bunfig.toml",
  "package.json",
];

const Severity = { Error: 1, Warning: 2 };
const MessageType = { Error: 1, Info: 3 };
const ErrorCodes = { MethodNotFound: -32601, InternalError: -32603 };
const DEFAULT_SETTINGS = { run: "onType", debounce: 200, quiet: false, typeAware: false, extraArgs: [], workingDirectory: null };
const RULE_DOCS = {
  "@typescript-eslint": (rule) => `https://typescript-eslint.io/rules/${rule}`,
  unicorn: (rule) => `https://github.com/sindresorhus/eslint-plugin-unicorn/blob/main/docs/rules/${rule}.md`,
  import: (rule) => `https://github.com/import-js/eslint-plugin-import/blob/main/docs/rules/${rule}.md`,
  react: (rule) => `https://github.com/jsx-eslint/eslint-plugin-react/blob/master/docs/rules/${rule}.md`,
  "react-hooks": () => "https://react.dev/reference/rules/rules-of-hooks",
  "jsx-a11y": (rule) => `https://github.com/jsx-eslint/eslint-plugin-jsx-a11y/blob/main/docs/rules/${rule}.md`,
};

const bun = process.execPath;
let workspaceRoots = [];
let settings = DEFAULT_SETTINGS;
let shuttingDown = false;
let reportedFailure = false;

/**
 * Open documents. `lint`, `fixAll` and `lines` cache work for one version of the text.
 * @typedef {{version: number, promise: Promise<any>}} Run
 * @type {Map<string, {uri: string, version: number, text: string, timer?: any, lint?: Run, fixAll?: Run, lines?: {version: number, starts: number[]}}>}
 */
const documents = new Map();

// ---------------------------------------------------------------------------
// JSON-RPC over stdio

let buffer = Buffer.alloc(0);
let nextRequestId = 1;
const pendingRequests = new Map();

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length: *(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }
    dispatch(message);
  }
});
process.stdin.on("end", () => handlers.exit());

function send(message) {
  const json = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function notify(method, params) {
  send({ method, params });
}

function request(method, params) {
  const id = `bun-lint-${nextRequestId++}`;
  send({ id, method, params });
  return new Promise((resolve) => pendingRequests.set(id, resolve));
}

function log(message, type = MessageType.Info) {
  notify("window/logMessage", { type, message: `[bun lint] ${message}` });
}

async function dispatch(message) {
  // A response to one of our requests
  if (message.id !== undefined && message.method === undefined) {
    const resolveRequest = pendingRequests.get(message.id);
    pendingRequests.delete(message.id);
    resolveRequest?.(message.error ? undefined : message.result);
    return;
  }

  const handler = handlers[message.method];
  const isRequest = message.id !== undefined;
  if (!handler) {
    if (isRequest) send({ id: message.id, error: { code: ErrorCodes.MethodNotFound, message: `Unhandled method ${message.method}` } });
    return;
  }
  try {
    const result = await handler(message.params ?? {});
    if (isRequest) send({ id: message.id, result: result ?? null });
  } catch (error) {
    log(`${message.method} failed: ${error?.stack ?? error}`, MessageType.Error);
    if (isRequest) send({ id: message.id, error: { code: ErrorCodes.InternalError, message: String(error?.message ?? error) } });
  }
}

// ---------------------------------------------------------------------------
// LSP handlers

const handlers = {
  initialize(params) {
    workspaceRoots = (params.workspaceFolders ?? [])
      .map((folder) => uriToPath(folder.uri))
      .concat(params.rootUri ? [uriToPath(params.rootUri)] : [])
      .filter(Boolean);
    applySettings(params.initializationOptions);
    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
        codeActionProvider: { codeActionKinds: ["quickfix", "source.fixAll", FIX_ALL_KIND] },
        documentFormattingProvider: true,
      },
      serverInfo: { name: "bun-lint", version: "0.1.0" },
    };
  },

  async initialized() {
    const [config] = (await request("workspace/configuration", { items: [{ section: "bun-lint" }] })) ?? [];
    if (config) applySettings(config);
  },

  shutdown() {
    shuttingDown = true;
    return null;
  },

  exit() {
    process.exit(shuttingDown ? 0 : 1);
  },

  "workspace/didChangeConfiguration"(params) {
    applySettings(params.settings);
    for (const doc of documents.values()) {
      doc.lint = doc.fixAll = undefined;
      scheduleLint(doc, 0);
    }
  },

  "textDocument/didOpen"({ textDocument }) {
    const doc = { uri: textDocument.uri, version: textDocument.version, text: textDocument.text };
    documents.set(doc.uri, doc);
    scheduleLint(doc, 0);
  },

  "textDocument/didChange"({ textDocument, contentChanges }) {
    const doc = documents.get(textDocument.uri);
    if (!doc) return;
    const full = contentChanges.findLast((change) => change.range === undefined);
    if (full) doc.text = full.text;
    doc.version = textDocument.version;
    if (settings.run === "onType") scheduleLint(doc, settings.debounce);
  },

  "textDocument/didSave"({ textDocument }) {
    const doc = documents.get(textDocument.uri);
    if (doc) scheduleLint(doc, 0);
  },

  "textDocument/didClose"({ textDocument }) {
    const doc = documents.get(textDocument.uri);
    clearTimeout(doc?.timer);
    documents.delete(textDocument.uri);
    notify("textDocument/publishDiagnostics", { uri: textDocument.uri, diagnostics: [] });
  },

  async "textDocument/codeAction"({ textDocument, range, context }) {
    const doc = documents.get(textDocument.uri);
    if (!doc) return [];
    const only = context?.only;
    const wants = (kind) => !only || only.some((requested) => kind === requested || kind.startsWith(`${requested}.`));

    const actions = [];
    // Only offer "fix all" from the lightbulb when something is fixable. When it is asked
    // for by kind (format on save), run it without linting first.
    let offerFixAll = wants(FIX_ALL_KIND);

    if (wants("quickfix")) {
      const result = await currentResult(doc);
      if (!result) return [];
      const lines = lineStartsOf(doc);
      for (const message of result.messages) {
        if (!message.ruleId || !rangesOverlap(messageRange(message, doc.text, lines), range)) continue;
        actions.push(...quickFixes(doc, message, lines));
      }
      offerFixAll ||= result.messages.some((message) => message.fix);
    }

    if (offerFixAll) {
      const edits = await fixAllEdits(doc);
      if (edits?.length) {
        const kind = wants(FIX_ALL_KIND) ? FIX_ALL_KIND : "quickfix";
        actions.push({ title: "Fix all auto-fixable problems", kind, edit: { changes: { [doc.uri]: edits } } });
      }
    }

    return actions;
  },

  async "textDocument/formatting"({ textDocument }) {
    const doc = documents.get(textDocument.uri);
    return doc ? ((await fixAllEdits(doc)) ?? []) : [];
  },
};

function applySettings(value) {
  if (!value || typeof value !== "object") return;
  // Merge onto the defaults, so a setting removed in Zed goes back to its default
  settings = { ...DEFAULT_SETTINGS, ...(value["bun-lint"] ?? value) };
  if (!Array.isArray(settings.extraArgs)) settings.extraArgs = [];
}

// ---------------------------------------------------------------------------
// Linting

function scheduleLint(doc, delay) {
  clearTimeout(doc.timer);
  doc.timer = setTimeout(() => lintAndPublish(doc), delay);
}

async function lintAndPublish(doc) {
  const version = doc.version;
  doc.lint = undefined; // always lint afresh here, e.g. on save
  const result = await currentResult(doc);
  if (!result || documents.get(doc.uri) !== doc || doc.version !== version) return;
  const lines = lineStartsOf(doc);
  notify("textDocument/publishDiagnostics", {
    uri: doc.uri,
    version,
    diagnostics: result.messages.map((message) => toDiagnostic(message, doc.text, lines)),
  });
}

/** The lint result for the buffer as it is now, sharing a run already started for this version. */
function currentResult(doc) {
  return runOncePerVersion(doc, "lint", async () => {
    const output = await runBunLint(doc, []);
    if (!output) return undefined;
    return { messages: (output.messages ?? []).filter((message) => !isIgnoredFileNotice(message)) };
  });
}

/** Edits that apply every auto-fix, from `bun lint --fix-dry-run`. Undefined if the buffer changed meanwhile. */
async function fixAllEdits(doc) {
  const version = doc.version;
  const edits = await runOncePerVersion(doc, "fixAll", async () => {
    const text = doc.text;
    const output = await runBunLint(doc, ["--fix-dry-run"]);
    if (output?.output === undefined) return undefined;
    return output.output === text ? [] : [minimalEdit(text, output.output)];
  });
  return doc.version === version ? edits : undefined;
}

/**
 * Runs `start` at most once per document version for `key`, so code actions and
 * formatting share one `bun lint` run. A run that fails (undefined) is not kept.
 */
function runOncePerVersion(doc, key, start) {
  if (doc[key]?.version === doc.version) return doc[key].promise;
  const run = { version: doc.version, promise: start() };
  doc[key] = run;
  run.promise.then((value) => {
    if (value === undefined && doc[key] === run) doc[key] = undefined;
  });
  return run.promise;
}

async function runBunLint(doc, extraArgs) {
  const path = uriToPath(doc.uri);
  if (!path) return undefined;

  const args = ["lint", "--no-script", "--stdin", "--stdin-filename", path, "--format", "json", "--no-color"];
  if (settings.quiet) args.push("--quiet");
  if (settings.typeAware) args.push("--type-aware");
  args.push(...settings.extraArgs, ...extraArgs);

  let proc;
  try {
    proc = Bun.spawn([bun, ...args], {
      cwd: workingDirectoryFor(path),
      stdin: new TextEncoder().encode(doc.text),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
  } catch (error) {
    reportFailure(`could not start bun: ${error?.message ?? error}`);
    return undefined;
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);

  // Exit code 1 means problems were found. Anything else that does not print JSON is a failure.
  try {
    const [output] = JSON.parse(stdout);
    reportedFailure = false;
    return output ?? { messages: [] };
  } catch {
    reportFailure(`\`bun ${args.join(" ")}\` exited with ${exitCode}\n${stderr.trim() || stdout.trim()}`);
    return undefined;
  }
}

function reportFailure(message) {
  log(message, MessageType.Error);
  if (reportedFailure) return;
  reportedFailure = true;
  notify("window/showMessage", { type: MessageType.Error, message: `bun lint failed. See the bun lint server log.\n${message.split("\n")[0]}` });
}

/** ESLint says "File ignored..." for files the config does not cover. The ESLint integration hides these too. */
function isIgnoredFileNotice(message) {
  return !message.ruleId && !message.fatal && /^File ignored\b/.test(message.message ?? "");
}

function workingDirectoryFor(path) {
  const root = workspaceRootFor(path);
  if (settings.workingDirectory) return resolve(root ?? dirname(path), settings.workingDirectory);
  let dir = dirname(path);
  for (;;) {
    if (CONFIG_FILES.some((name) => existsSync(join(dir, name)))) return dir;
    const parent = dirname(dir);
    if (parent === dir || (root && !isInside(parent, root))) break;
    dir = parent;
  }
  return root ?? dirname(path);
}

function workspaceRootFor(path) {
  return workspaceRoots.filter((root) => isInside(path, root)).sort((a, b) => b.length - a.length)[0];
}

function isInside(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

// ---------------------------------------------------------------------------
// Diagnostics and code actions

function toDiagnostic(message, text, lines) {
  const diagnostic = {
    range: messageRange(message, text, lines),
    severity: message.severity === 2 ? Severity.Error : Severity.Warning,
    source: SOURCE,
    message: message.message,
  };
  if (message.ruleId) {
    diagnostic.code = message.ruleId;
    const href = ruleUrl(message.ruleId);
    if (href) diagnostic.codeDescription = { href };
  }
  return diagnostic;
}

function quickFixes(doc, message, lines) {
  const rule = message.ruleId;
  const diagnostics = [toDiagnostic(message, doc.text, lines)];
  const quickfix = (title, edit, extra) => ({ title, kind: "quickfix", ...extra, diagnostics, edit: { changes: { [doc.uri]: [edit] } } });
  const insertAt = (line, newText) => ({ range: { start: { line, character: 0 }, end: { line, character: 0 } }, newText });

  const actions = [];
  if (message.fix) actions.push(quickfix(`Fix this ${rule} problem`, fixToEdit(message.fix, lines), { isPreferred: true }));
  for (const suggestion of message.suggestions ?? []) {
    actions.push(quickfix(suggestion.desc ?? `Apply the ${rule} suggestion`, fixToEdit(suggestion.fix, lines)));
  }

  // eslint-disable-next-line above the problem line, keeping its indentation
  const line = zeroBased(message.line);
  const indent = /^[ \t]*/.exec(doc.text.slice(lines[line], lines[line + 1] ?? doc.text.length))[0];
  actions.push(quickfix(`Disable ${rule} for this line`, insertAt(line, `${indent}// eslint-disable-next-line ${rule}\n`)));

  // /* eslint-disable */ at the top of the file, below any shebang
  const fileLine = doc.text.startsWith("#!") ? 1 : 0;
  actions.push(quickfix(`Disable ${rule} for the entire file`, insertAt(fileLine, `/* eslint-disable ${rule} */\n`)));

  return actions;
}

function ruleUrl(ruleId) {
  if (!ruleId.includes("/")) return `https://eslint.org/docs/latest/rules/${ruleId}`;
  const [plugin, rule] = ruleId.split("/");
  return RULE_DOCS[plugin]?.(rule);
}

// ---------------------------------------------------------------------------
// Positions. ESLint reports 1-based lines and columns, and fix ranges as string
// offsets. Both count UTF-16 code units, the same as LSP positions and JS strings.

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) starts.push(i + 1);
    else if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/** `lineStarts` of the document's current text, computed once per version. */
function lineStartsOf(doc) {
  if (doc.lines?.version !== doc.version) doc.lines = { version: doc.version, starts: lineStarts(doc.text) };
  return doc.lines.starts;
}

/** An ESLint 1-based line or column as a 0-based LSP one. */
function zeroBased(n) {
  return Math.max(0, (n ?? 1) - 1);
}

function offsetToPosition(offset, lines) {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lines[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: offset - lines[low] };
}

function messageRange(message, text, lines) {
  const startLine = zeroBased(message.line);
  const start = { line: startLine, character: zeroBased(message.column) };
  if (message.endLine) {
    return { start, end: { line: message.endLine - 1, character: zeroBased(message.endColumn) } };
  }
  // No end: underline to the end of the line, like the ESLint integration does for parse errors
  const lineEnd = (lines[startLine + 1] ?? text.length + 1) - 1;
  const endChar = Math.max(start.character, lineEnd - lines[startLine]);
  return { start, end: { line: startLine, character: text[lineEnd - 1] === "\r" ? endChar - 1 : endChar } };
}

function fixToEdit(fix, lines) {
  return {
    range: { start: offsetToPosition(fix.range[0], lines), end: offsetToPosition(fix.range[1], lines) },
    newText: fix.text,
  };
}

function rangesOverlap(a, b) {
  const before = (x, y) => x.line < y.line || (x.line === y.line && x.character < y.character);
  return !before(a.end, b.start) && !before(b.end, a.start);
}

/** One edit covering only the changed middle part, so the cursor and folds stay put. */
function minimalEdit(before, after) {
  let start = 0;
  const maxStart = Math.min(before.length, after.length);
  while (start < maxStart && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore--;
    endAfter--;
  }
  const lines = lineStarts(before);
  return {
    range: { start: offsetToPosition(start, lines), end: offsetToPosition(endBefore, lines) },
    newText: after.slice(start, endAfter),
  };
}

function uriToPath(uri) {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
}
