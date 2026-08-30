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

# 开发宿主：加载本扩展打开 vault（editor: vscodium(默认) | vscode）
# 编辑器不是本仓库 flake 的输出——这只是 nix run nixpkgs 的快捷方式。
dev editor='vscodium' vault='.':
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f out/extension.js ]; then
        echo "vscode-notist: out/extension.js missing — run 'bun run compile' first" >&2
        exit 1
    fi
    case "{{editor}}" in
        vscode)
            NIXPKGS_ALLOW_UNFREE=1 exec nix run --impure nixpkgs#vscode -- \
                --extensionDevelopmentPath="$PWD" "{{vault}}"
            ;;
        vscodium)
            exec nix run nixpkgs#vscodium -- --extensionDevelopmentPath="$PWD" "{{vault}}"
            ;;
        *)
            echo "unknown editor: {{editor}} (use vscodium | vscode)" >&2
            exit 2
            ;;
    esac
