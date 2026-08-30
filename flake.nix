{
	description = "vscode-notist: .not support for VS Code (dev environment)";

	inputs = {
		nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
		# devShell 自带的 notist（LSP server 也在内），rev 钉在 flake.lock，
		# 升级走 nix flake update notist——与 zed-notist 钉 grammar rev 同一套路。
		notist.url = "github:AzurIce/Notist";
	};

	outputs =
		{
			nixpkgs,
			notist,
			...
		}:
		let
			systems = [
				"x86_64-linux"
				"aarch64-linux"
				"x86_64-darwin"
				"aarch64-darwin"
			];
			forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
		in
		{
			# 只有 devShell。开发宿主（编辑器）不属于本仓库的输出：
			# 见 justfile 的 dev 配方 / README「开发」。
			devShells = forAllSystems (pkgs: {
				default = pkgs.mkShell {
					packages = [
						pkgs.bun
						pkgs.git
						pkgs.just
						# PATH 里的 notist：lsp-smoke 免配置，编辑器宿主经 `just dev`
						# 的 nix develop -c 包装继承它，扩展据此拉起 `notist lsp`。
						# doCheck=false：notist 上游测试在沙箱里需要
						# XDG_CACHE_HOME/NOTIST_DATA_DIR（其 flake 的 preCheck），
						# 该修复在 GitHub 上的 rev（2026-08-30 时点为 d4f4df0）尚未
						# 包含；等 origin/main 含 84b3727 后删掉这个 overrideAttrs
						# 即可恢复上游测试。
						(notist.packages.${pkgs.system}.notist.overrideAttrs (_: {
							doCheck = false;
						}))
					];
				};
			});
		};
}
