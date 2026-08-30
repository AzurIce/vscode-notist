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

# Byte↔position conversion round-trip (CJK / emoji / surrogate pairs)
sourcemap-smoke:
    bun scripts/sourcemap-smoke.mjs

# Drive a real `notist lsp` end-to-end (FULL sync, diagnostics, render…)
# Optional arg: path to the notist binary.
lsp-smoke NOTIST_BIN='':
    bun scripts/lsp-smoke.mjs {{NOTIST_BIN}}

# 开发宿主：加载本扩展打开 vault（editor: vscodium(默认) | vscode）
# 编辑器不是本仓库 flake 的输出——这只是 nix run nixpkgs 的快捷方式；
# nix develop -c 让它继承 devShell 的 PATH（含 notist，扩展据此拉起 LSP）。
dev editor='vscodium' vault='.':
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f out/extension.js ]; then
        echo "vscode-notist: out/extension.js missing — run 'bun run compile' first" >&2
        exit 1
    fi
    case "{{editor}}" in
        vscode)
            NIXPKGS_ALLOW_UNFREE=1 exec nix develop -c nix run --impure nixpkgs#vscode -- \
                --extensionDevelopmentPath="$PWD" "{{vault}}"
            ;;
        vscodium)
            exec nix develop -c nix run nixpkgs#vscodium -- --extensionDevelopmentPath="$PWD" "{{vault}}"
            ;;
        *)
            echo "unknown editor: {{editor}} (use vscodium | vscode)" >&2
            exit 2
            ;;
    esac
