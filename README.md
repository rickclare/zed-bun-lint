# Bun Lint for Zed

Shows `bun lint` problems in Zed the way the built-in ESLint integration does:

- Diagnostics as you type (or on save), with each rule linked to its docs
- Quick fixes: apply the rule's fix or a suggestion, or disable the rule for a line or for the whole file
- **Fix all auto-fixable problems**, as the `source.fixAll.bunlint` code action, so it can run on save

`bun lint` has no LSP mode. This extension includes a small language server with no dependencies, `server/bun-lint-lsp.js`. It runs with the project's own `bun` (found on the worktree's shell `PATH`, so mise and asdf work). It lints the unsaved buffer with `bun lint --stdin --stdin-filename <file> --format json` and reads ESLint's JSON format from the output. `bun lint` reads the same `eslint.config.*` files as ESLint.

Requires Bun 1.4 or later, which includes `bun lint`.

## Install

1. Install Rust with rustup. Zed compiles the extension itself.
2. In Zed, run **zed: install dev extension** and pick this folder.

## Use it in place of ESLint

In `.zed/settings.json` or your user settings:

```jsonc
{
  "languages": {
    "JavaScript": {
      "language_servers": ["bun-lint", "!eslint", "..."],
      "format_on_save": "on",
      "formatter": [
        { "code_action": "source.fixAll.bunlint" },
        { "external": { "command": "bun", "arguments": ["fmt", "--stdin-filepath", "{buffer_path}"] } },
      ],
    },
    // The same for "TypeScript" and "TSX"
  },
}
```

The `"..."` entry already enables the server for JavaScript, TypeScript and TSX. Adding `"!eslint"` stops both linters reporting the same problems.

## Settings

```jsonc
{
  "lsp": {
    "bun-lint": {
      "settings": {
        "run": "onType",         // or "onSave"
        "debounce": 200,         // ms to wait after typing before linting
        "quiet": false,          // report errors only
        "typeAware": false,      // also run the rules that need types (--type-aware)
        "extraArgs": [],         // more arguments for every `bun lint` run
        "workingDirectory": null, // default: the nearest folder above the file with a lint config or package.json
      },
      // Optional: use a specific bun
      "binary": { "path": "/path/to/bun" },
    },
  },
}
```

The server always passes `--no-script`, so a `lint` script in `package.json` doesn't replace the linter.

## Troubleshooting

Open **dev: open language server logs** and choose `bun lint`. If a run fails (for example, the config can't load), the full command and its stderr appear there, and Zed shows a one-line notice.

## Develop

```sh
bun test                                         # drives the server over stdio against a fixture project
cargo build --release --target wasm32-wasip2     # what Zed builds
```

Edit `server/bun-lint-lsp.js`, then run **zed: rebuild dev extension** (the script is embedded in the extension).
