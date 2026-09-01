/**
 * TextMate grammar smoke test: loads syntaxes/notist.tmLanguage.json through
 * vscode-textmate + oniguruma (the same engines VS Code uses), tokenizes the
 * fixture, and asserts a floor of expected scopes. Catches grammar syntax
 * errors (bad regexes, broken backrefs) and regressions in the core rules.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import vscodeTextmate from "vscode-textmate";
import vscodeOniguruma from "vscode-oniguruma";

const { Registry } = vscodeTextmate;
const { loadWASM } = vscodeOniguruma;

const require = createRequire(import.meta.url);
const onigDir = dirname(require.resolve("vscode-oniguruma/package.json"));
await loadWASM(readFileSync(join(onigDir, "release/onig.wasm")));

const registry = new Registry({
	onigLib: Promise.resolve(vscodeOniguruma),
	loadGrammar: async (scopeName) => {
		if (scopeName !== "source.notist") return null;
		return JSON.parse(readFileSync(new URL("../syntaxes/notist.tmLanguage.json", import.meta.url), "utf8"));
	},
});

const grammar = await registry.loadGrammar("source.notist");
if (grammar === null) throw new Error("grammar failed to load");

const source = readFileSync(new URL("./fixtures/sample.not", import.meta.url), "utf8");
const lines = source.split("\n");

/** line-indexed token dumps, chained through the shared rule stack */
const tokens = new Array(lines.length);
let ruleStack = null;
for (let i = 0; i < lines.length; i++) {
	const r = grammar.tokenizeLine(lines[i], ruleStack);
	tokens[i] = r.tokens;
	ruleStack = r.ruleStack;
}

const has = (line, substr) =>
	line >= 0 && tokens[line].some((t) => t.scopes.some((s) => s.includes(substr)));

const lineOf = (needle) => lines.findIndex((l) => l.includes(needle));

const checks = [
	// [description, line (0-based), scope substring]
	["heading marker", lineOf("= 标题"), "punctuation.definition.heading"],
	["heading body", lineOf("= 标题"), "entity.name.section"],
	["module annotation", lineOf('@!('), "meta.annotation.module"],
	["annotation shorthand", lineOf("@note"), "entity.other.attribute-name"],
	["annotation block", lineOf("@(wip"), "meta.annotation.block"],
	["annotation spread", lineOf("..defaults"), "keyword.operator.spread"],
	["annotation property", lineOf('@!('), "keyword.operator.assignment"],
	["annotation string value", lineOf('@!('), "string.quoted.double"],
	["import keyword", lineOf("#import"), "keyword.control.import"],
	["import target", lineOf("#import"), "meta.reference"],
	["import alias", lineOf("#import"), "keyword.control.import.as"],
	["code let keyword", lineOf("#let total"), "keyword.control"],
	["code block comment", lineOf("#let total"), "comment.block"],
	["code line comment", lineOf("#let total"), "comment.line"],
	["string quoted", lineOf('#let greeting'), "string.quoted.double"],
	["strong", lineOf("= 标题"), "markup.bold"],
	["inline raw", lineOf("Run `cargo test`"), "markup.inline.raw"],
	["semicolon embed", lineOf("#accent;"), "variable.other"],
	["paren embed", lineOf("#(1 + 2)"), "meta.embedded.expression"],
	["target reference", lineOf("#<vault::intro>"), "meta.reference"],
	["reserved segment", lineOf("#<vault::intro>"), "keyword.other.reserved"],
	["list marker", lineOf("- 列表项"), "punctuation.definition.list_item"],
	["task marker", lineOf("- [ ]"), "punctuation.definition.task"],
	["enum marker", lineOf("+ 枚举项"), "punctuation.definition.list_item"],
	["rule", lines.findIndex((l) => l.trim() === "---"), "punctuation.definition.rule"],
	["table delimiter", lineOf(":-"), "meta.table.delimiter"],
	["content block", lineOf("#[一段内容]"), "meta.content-block"],
	["fence info", lines.findIndex((l) => l.trim() === "```rust"), "constant.other.language"],
	["escape", lineOf("\\#"), "constant.character.escape"],
	["raw string", lineOf("r#\"raw"), "string.quoted.double.raw"],
	["escaped string", lineOf('#let greeting'), "constant.character.escape"],
	["type name", lineOf("(x: Int)"), "support.type"],
	["function sugar param", lineOf("#let double(x: Int)"), "variable.parameter"],
	["arrow operator", lineOf("#let double(x: Int)"), "keyword.operator"],
	["numeric", lineOf("#(1 + 2)"), "constant.numeric"],
	["if keyword", lineOf("#if total"), "keyword.control"],
	["else keyword", lineOf("#if total"), "keyword.control"],
	["unit literal", lineOf("else { () }"), "keyword.operator"],
	["lambda arrow", lineOf("=> a + b"), "keyword.operator"],
];

let failures = 0;
for (const [desc, line, scope] of checks) {
	if (line < 0) {
		console.error(`FAIL  ${desc}: fixture line not found`);
		failures++;
		continue;
	}
	if (!has(line, scope)) {
		console.error(`FAIL  ${desc} (line ${line + 1}): no scope matching "${scope}"`);
		console.error("      got:", tokens[line].map((t) => t.scopes.filter((s) => s !== "source.notist").join(" ")).join(" | "));
		failures++;
	} else {
		console.log(`ok    ${desc}`);
	}
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\ntextmate grammar: all checks passed");
