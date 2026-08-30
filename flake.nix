{
	description = "vscode-notist: .not support for VS Code (dev environment)";

	inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

	outputs =
		{ nixpkgs, ... }:
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
			# 见 README「开发」——直接 nix run nixpkgs#vscodium，或包进个人 flake。
			devShells = forAllSystems (pkgs: {
				default = pkgs.mkShell {
					packages = with pkgs; [
						bun
						git
						just
					];
				};
			});
		};
}
