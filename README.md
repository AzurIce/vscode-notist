# vscode-notist

[Notist](https://github.com/AzurIce/Notist)（`.not` 知识库语言）的 VS Code 扩展：语法高亮、语言服务器（诊断 / 补全 / 导航 / hover）与实时预览。

姊妹项目：[notist](https://github.com/AzurIce/Notist)（上游）、[tree-sitter-notist](https://github.com/AzurIce/tree-sitter-notist)、[zed-notist](https://github.com/AzurIce/zed-notist)、[obsidian-notist](https://github.com/AzurIce/obsidian-notist)。跨仓库路径约定见 notist 仓库根的 `AGENTS.md` 与 `.env`。

## 功能

- **语法高亮**：TextMate grammar（`syntaxes/notist.tmLanguage.json`），覆盖标题 / 列表 / 表格 / 标注 / Target 引用 / Code 嵌入表达式（字符串、注释、类型、运算符）等完整语法面。语义上不完全等价于 tree-sitter 语法（TextMate 无法配平嵌套括号、无法跨行判定表格分隔行），但构造覆盖一致。
- **LSP**：由 `notist lsp` 提供（需 notist 在 PATH 或经设置指定），经 `vscode-languageclient` 接入：
  - 推送诊断（ Problems 面板，`source: notist`）
  - 补全（`[` `:` `#` `(` `,` `<` `/` 触发）、hover、definition / references、文档与工作区符号
  - 实验方法 `notist/documentReferences`（命令 **Notist: Show Document References**，按模块整体查询引用）
- **预览**：命令 **Notist: Open Preview**（`ctrl+shift+v`）/ **Open Preview to the Side**（`ctrl+k v`）。走实验方法 `notist/renderDocument`，与 `notist build` / `notist preview` 同一渲染管线；输入时 500ms 防抖重渲，保留滚动位置，资源链接改写到工作区文件，模块页锚点可点击跳转到对应 `.not` 源文件。主题跟随编辑器明暗。
- **滚动同步与点击跳源码**：渲染器的 `data-notist-start/end` 字节属性（SyncTeX 式思路）驱动双向同步——编辑器滚动跟预览、预览滚动跟编辑器（只动视口，不抢焦点）、点击预览元素跳到源码对应位置。三个方向各有开关（`notist.preview.scrollPreviewWithEditor` / `scrollEditorWithPreview` / `clickToSource`）。
  - 已知差距：插件 web 组件（mermaid 等）未加载，相关片段降级为静态内容。

## 前置条件

vault 根目录（或其上层）需要 `Notist.toml` 标记，且 `notist` CLI 可用：

```sh
cargo install --locked --git https://github.com/AzurIce/Notist.git notist-cli
# 或 nix run github:AzurIce/Notist
```

找不到 server 时预览与诊断会提示；`notist.server.command` 支持 `nix run` 之类的包装命令（`lsp` 子命令自动追加）。

## 设置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `notist.server.command` | `notist` | 启动 LSP 的命令 |
| `notist.server.args` | （空） | 插在命令与 `lsp` 子命令之间的参数，如 `--no-daemon` |
| `notist.preview.debounceMs` | `500` | 输入防抖 |
| `notist.preview.scrollPreviewWithEditor` | `true` | 编辑器滚动带动预览 |
| `notist.preview.scrollEditorWithPreview` | `true` | 预览滚动带动编辑器 |
| `notist.preview.clickToSource` | `true` | 点击预览跳到源码位置 |

server 本身不消费任何客户端配置；修改 `notist.server.*` 会自动重启 server。

## 开发

```sh
direnv allow          # 或 nix develop
bun install
bun run compile       # tsc + esbuild → out/extension.js
just lsp-smoke        # 对真实 notist lsp 跑协议契约检查（notist 由 devShell 提供）
just tm-smoke         # TextMate grammar 检查
```

devShell 自带 notist 二进制：flake input `notist` = `github:AzurIce/Notist`，rev 钉在
flake.lock（`nix flake update notist` 升级，与 zed-notist 钉 grammar rev 同一套路）。
要针对本地 notist 检出调试时：

```sh
nix develop --override-input notist "git+file:$NOTIST_PATH"
```

调试用的编辑器宿主不属于本仓库 flake 的输出。`just dev` 是 `nix run` 的快捷方式，并用
`nix develop -c` 包装让编辑器继承 devShell 的 PATH（含 notist）；先 `bun run compile`：

```sh
just dev                        # vscodium + 本扩展，打开当前目录
just dev vscode ~/path/to/vault # 真 VS Code（unfree 由配方内部放行）
```

等价的手动命令：

```sh
nix develop -c nix run nixpkgs#vscodium -- --extensionDevelopmentPath="$PWD" ~/path/to/vault
NIXPKGS_ALLOW_UNFREE=1 nix develop -c nix run --impure nixpkgs#vscode -- --extensionDevelopmentPath="$PWD" ~/path/to/vault
```

打包：`npx @vscode/vsce package`。

刷新内嵌站点样式：`just fetch-site-assets`（需要 `NOTIST_PATH`，见 `.env.example`）。
