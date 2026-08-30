/**
 * SourceMap round-trip smoke test (run under bun, which transpiles the
 * imported TS directly): UTF-8 byte offsets ↔ LSP utf-16 positions across
 * CJK text, emoji (surrogate pairs), escapes and multi-line documents.
 */
import { SourceMap } from "../src/source-map.ts";

const text = [
	"# 标题 *强调* 中文 heading",
	"",
	"第一段#accent;文字 与 emoji 🎉🎉 inline.",
	"",
	"```rust",
	'fn main() { let s = "日本語"; }',
	"```",
	"- 清单项 α β γ 𝕏𝕐",
	"trailing line no newline",
].join("\n");

const map = SourceMap.fromText(text);

let failures = 0;
function check(desc, ok, detail = "") {
	if (ok) console.log(`ok    ${desc}`);
	else {
		failures++;
		console.error(`FAIL  ${desc}${detail ? `: ${detail}` : ""}`);
	}
}

check("line count", map.lineCount === 9, `got ${map.lineCount}`);
check("line 0 starts at 0", map.byteAtLine(0) === 0);
check(
	"byteAtLine matches byteOfPosition at column 0",
	[0, 1, 3, 7].every((l) => map.byteAtLine(l) === map.byteOfPosition({ line: l, character: 0 })),
);
check("out-of-range clamps", map.byteOfPosition({ line: 99, character: 0 }) === map.byteOfPosition({ line: 8, character: 0 }));
check("byte clamp", map.position(Number.MAX_SAFE_INTEGER).line === map.lineCount - 1);

// Full sweep: at every code-point boundary the mapping must round-trip
// exactly, and the manually tracked (line, utf16 column) must match.
let byte = 0;
let i = 0;
let line = 0;
let ch = 0;
let boundaries = 0;
let firstMismatch = "";
while (i < text.length) {
	const gotPos = map.position(byte);
	if (gotPos.line !== line || gotPos.character !== ch) {
		firstMismatch ||= `position(${byte}) = ${JSON.stringify(gotPos)}, want ${JSON.stringify({ line, character: ch })}`;
	}
	const gotByte = map.byteOfPosition({ line, character: ch });
	if (gotByte !== byte) {
		firstMismatch ||= `byteOfPosition(${line},${ch}) = ${gotByte}, want ${byte}`;
	}
	boundaries++;

	const code = text.charCodeAt(i);
	const isPair =
		code >= 0xd800 &&
		code <= 0xdbff &&
		i + 1 < text.length &&
		text.charCodeAt(i + 1) >= 0xdc00 &&
		text.charCodeAt(i + 1) <= 0xdfff;
	const codePoint = isPair ? text.codePointAt(i) : code;
	byte += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
	if (code === 0x0a) {
		line += 1;
		ch = 0;
	} else {
		ch += isPair ? 2 : 1;
	}
	i += isPair ? 2 : 1;
}
check(`round-trip at all ${boundaries} code-point boundaries`, firstMismatch === "", firstMismatch);

// Mid-code-point byte targets snap to that code point's start.
const emojiLineStart = map.byteAtLine(2);
const emojiPos = map.position(emojiLineStart + 40);
check("mid-code-point snap stays a char boundary", map.byteOfPosition(emojiPos) <= emojiLineStart + 40);

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nsource map: all checks passed");
