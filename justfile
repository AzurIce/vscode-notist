default:
    @just --list

compile:
    bun run compile

watch:
    bun run watch

# Refresh the vendored site stylesheet from a local notist checkout (needs NOTIST_PATH)
fetch-site-assets:
    bun scripts/fetch-site-assets.mjs

# Tokenize fixtures through vscode-textmate and check expected scopes
tm-smoke:
    bun scripts/tm-smoke.mjs

# Drive a real `notist lsp` end-to-end (FULL sync, diagnostics, render…)
# Optional arg: path to the notist binary.
lsp-smoke NOTIST_BIN='':
    bun scripts/lsp-smoke.mjs {{NOTIST_BIN}}
