//! Zed extension that runs `bun lint` as a language server.
//!
//! `bun lint` has no LSP mode, so the extension ships a small LSP server
//! (`server/bun-lint-lsp.js`) and runs it with the project's own `bun`. That
//! server lints each buffer through `bun lint --stdin --format json` and turns the
//! ESLint-compatible output into diagnostics, quick fixes and a fix-all action.

use std::fs;

use zed_extension_api::{
    self as zed, serde_json, settings::LspSettings, LanguageServerId, Result, Worktree,
};

const SERVER_SOURCE: &str = include_str!("../server/bun-lint-lsp.js");
const SERVER_FILE: &str = "bun-lint-lsp.js";

struct BunLintExtension;

impl BunLintExtension {
    /// Writes the bundled server into the extension's work directory, if it
    /// is missing or out of date, and returns its absolute path.
    fn server_path(&self) -> Result<String> {
        if fs::read_to_string(SERVER_FILE).ok().as_deref() != Some(SERVER_SOURCE) {
            fs::write(SERVER_FILE, SERVER_SOURCE)
                .map_err(|e| format!("failed to write {SERVER_FILE}: {e}"))?;
        }
        let dir = std::env::current_dir()
            .map_err(|e| format!("failed to read the extension directory: {e}"))?;
        Ok(dir.join(SERVER_FILE).to_string_lossy().into_owned())
    }
}

impl zed::Extension for BunLintExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<zed::Command> {
        let binary = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.binary);

        let bun = binary
            .as_ref()
            .and_then(|binary| binary.path.clone())
            .or_else(|| worktree.which("bun"))
            .ok_or("bun lint: could not find `bun` on the PATH. Install Bun or set lsp.bun-lint.binary.path")?;

        let mut args = vec![self.server_path()?, "--stdio".to_string()];
        if let Some(extra) = binary.and_then(|binary| binary.arguments) {
            args.extend(extra);
        }

        Ok(zed::Command {
            command: bun,
            args,
            env: worktree.shell_env(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.settings))
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.settings))
    }
}

zed::register_extension!(BunLintExtension);
