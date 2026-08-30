default:
    @just --list

compile:
    npm run compile

watch:
    npm run watch

# Refresh the vendored site stylesheet from a local notist checkout (needs NOTIST_PATH)
fetch-site-assets:
    node scripts/fetch-site-assets.mjs

# Tokenize fixtures through vscode-textmate and check expected scopes
tm-smoke:
    node scripts/tm-smoke.mjs

# Drive a real `notist lsp` end-to-end (FULL sync, diagnostics, render…)
# Optional arg: path to the notist binary.
lsp-smoke NOTIST_BIN='':
    node scripts/lsp-smoke.mjs {{NOTIST_BIN}}
