# AGENTS.md

- 跨仓库路径：`.env`（gitignored，模板见 `.env.example`）声明 `NOTIST_PATH` 指向 notist 源码目录。Agent shell 不会自动加载 `.env`/direnv，用前先 `echo "$NOTIST_PATH"` 确认；为空时可 `set -a; . ./.env; set +a`，不要猜路径。
- 文档归属：notist 全部文档在 `$NOTIST_PATH/docs/`（`.not` 格式，不出 `.md`）；本扩展相关的设计/调研文档放 `$NOTIST_PATH/docs/vscode-notist/`，AI 整理类放 `$NOTIST_PATH/docs/ai/`（`yyyy-mm-dd xxx` 命名并在 `docs/ai/README.not` 登记摘要）。遵守 `$NOTIST_PATH/AGENTS.md` 与 `$NOTIST_PATH/docs/AGENTS.md`。
- 版本观：项目未发布过任何版本，不用 v1/v2 指代迭代；引用历史状态用日期或 commit hash。第三方产品自身版本号不受限（如 VS Code 1.90）。
- 语法变更时同步：TextMate grammar（`syntaxes/notist.tmLanguage.json`）是从 tree-sitter-notist 的 grammar/queries 移植的近似，上游文法变了要对照 `scripts/fixtures/sample.not` 与 `just tm-smoke` 更新；不追求 token 级等价，但构造覆盖要一致。预览的滚动同步/点击跳源码依赖渲染器输出的 `data-notist-start/-end` 字节属性（notist-html 的 `range_attributes_range`），上游改属性名会破坏同步。
- LSP 契约记录在 `src/protocol.ts` 头注释（对齐 `crates/notist-cli/src/lsp.rs`），上游 LSP 变更时逐条核对，并跑 `just lsp-smoke`（对真实 `notist lsp`）回归。
- 构建链：bun 是唯一工具链（对齐 obsidian-notist，devShell 不含 nodejs）；tsc 只做类型检查（`bun x tsc -noEmit`），产物由 esbuild 打包（CJS，external: vscode），最终跑在 VS Code 的 Node 扩展宿主里；`out/` 与 `node_modules/` 不进 git。flake 只有 devShell（bun/git/just，外加 input `notist` = `github:AzurIce/Notist` 钉 rev 提供的 notist 二进制——注意 git 仓库 flake 的相对 `path:` input 会相对 store 拷贝解析， sibling 检出要用 `--override-input notist "git+file:$NOTIST_PATH"` 引入；上游 flake 的测试在沙箱需要 84b3727 的 preCheck 修复，origin 补上之前 devShell 用 `overrideAttrs doCheck=false` 跳过）；编辑器宿主不是本仓库的输出，`just dev` 是 `nix develop -c nix run nixpkgs#…` 的快捷方式；`assets/site/` 是从 notist 构建产物拷贝的站点样式，来源与刷新方式见其 `UPSTREAM.txt`。
