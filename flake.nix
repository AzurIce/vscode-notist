{
	description = "vscode-notist: .not support for VS Code (dev environment + dev host)";

	inputs = {
		nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
		flake-utils.url = "github:numtide/flake-utils";
	};

	outputs =
		{ self, nixpkgs, flake-utils }:
		flake-utils.lib.eachDefaultSystem (
			system:
			let
				pkgs = nixpkgs.legacyPackages.${system};

				# 开发宿主脚本：从当前目录加载扩展（node_modules 与 out/ 都不进
				# flake store 拷贝，必须用工作树路径），可带一个要打开的 vault 目录。
				devhost =
					editorBin: editorPkg:
					''
					dir="''${1:-$PWD}"
					if [ ! -f "$dir/out/extension.js" ]; then
						echo "vscode-notist: $dir/out/extension.js missing — run 'npm run compile' first" >&2
						exit 1
					fi
					[ $# -gt 0 ] && shift
					exec ${editorPkg}/bin/${editorBin} --extensionDevelopmentPath="$dir" "$@"
					'';
			in
			{
				devShells.default = pkgs.mkShell {
					packages = with pkgs; [
						nodejs_22
						git
						just
					];
				};

				# 编辑器只出现在这里，不进 devShell——`nix run .#` 时才构建其闭包。
				apps.default = {
					type = "app";
					program = toString (
						pkgs.writeShellScript "vscode-notist-devhost" (devhost "codium" pkgs.vscodium)
					);
				};

				apps.vscode = {
					type = "app";
					program = toString (
						pkgs.writeShellScript "vscode-notist-devhost" (devhost "code" pkgs.vscode)
					);
				};
			}
		);
}
