/**
 * Refreshes assets/site/ from a local notist checkout: runs `notist build`
 * over $NOTIST_PATH/docs and copies the site stylesheet. Mirrors obsidian
 * -notist's `assets:site` script, minus the plugin web components (not yet
 * loaded by the VSCode preview).
 *
 * Needs NOTIST_PATH (see .env / .env.example).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const notistPath = process.env.NOTIST_PATH;
if (!notistPath) {
	console.error("NOTIST_PATH is not set (see .env.example)");
	process.exit(1);
}
const notistDir = resolve(notistPath.replace(/^~(?=\/|$)/, process.env.HOME ?? ""));
const vault = join(notistDir, "docs");
const out = mkdtempSync(join(tmpdir(), "notist-site-"));

try {
	execFileSync("notist", ["build", "--output", out], { cwd: vault, stdio: "inherit" });
	copyFileSync(join(out, "_notist/style.css"), "assets/site/style.css");
} finally {
	rmSync(out, { recursive: true, force: true });
}

const rev = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
	cwd: notistDir,
	encoding: "utf8",
}).trim();
const date = new Date().toISOString().slice(0, 10);
writeFileSync(
	"assets/site/UPSTREAM.txt",
	`notist repo   @ ${rev}  (dist/_notist/style.css, copied ${date})\nrefresh via: just fetch-site-assets (needs NOTIST_PATH)\n`,
);
console.log(`assets/site/style.css refreshed from notist @ ${rev}`);
