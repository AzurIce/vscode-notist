/**
 * End-to-end smoke test against a real `notist lsp` process: the whole
 * surface the VSCode extension relies on — initialize/utf-16 negotiation,
 * FULL-sync didOpen, push diagnostics, hover, completion, and the two
 * experimental methods (renderDocument, documentReferences) — exercised over
 * stdio JSON-RPC. Usage:
 *
 *   node scripts/lsp-smoke.mjs [path-to-notist] [vault-dir]
 *
 * Defaults: binary = $NOTIST_BIN || $NOTIST_PATH/target/debug/notist ||
 * $NOTIST_PATH/target/release/notist || `notist`; vault = $NOTIST_PATH/docs.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const home = process.env.HOME ?? "";

function findNotist() {
	const candidates = [
		process.argv[2],
		process.env.NOTIST_BIN,
		join(home, "Files/notist/target/debug/notist"),
		join(home, "Files/notist/target/release/notist"),
	];
	for (const c of candidates) {
		if (c && existsSync(c)) return resolve(c.replace(/^~(?=\/|$)/, home));
	}
	return "notist";
}

const notist = findNotist();
const notistPath = process.env.NOTIST_PATH ? resolve(process.env.NOTIST_PATH.replace(/^~(?=\/|$)/, home)) : null;
const vault = process.argv[3]
	? resolve(process.argv[3])
	: notistPath
		? join(notistPath, "docs")
		: process.cwd();
const targetDoc = join(vault, "intro.not");
if (!existsSync(targetDoc)) {
	console.error(`vault doc not found: ${targetDoc}`);
	process.exit(1);
}

console.log(`server : ${notist}`);
console.log(`vault  : ${vault}`);

// --- minimal stdio JSON-RPC client ------------------------------------------

const child = spawn(notist, ["lsp"], { cwd: vault, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => {
	stderr += d;
});

let buffer = Buffer.alloc(0);
const pending = new Map();
const notifications = [];
let nextId = 1;
let waiters = [];

child.stdout.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const header = buffer.slice(0, headerEnd).toString("utf8");
		const match = /Content-Length: (\d+)/i.exec(header);
		if (!match) throw new Error(`bad header: ${header}`);
		const length = Number(match[1]);
		if (buffer.length < headerEnd + 4 + length) return;
		const body = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString("utf8"));
		buffer = buffer.slice(headerEnd + 4 + length);
		if (body.id !== undefined && (body.method !== undefined || pending.has(body.id))) {
			const resolver = pending.get(body.id);
			if (resolver) {
				pending.delete(body.id);
				if (body.error !== undefined) resolver.reject(body.error);
				else resolver.resolve(body.result);
			}
		} else if (body.method) {
			notifications.push(body);
			waiters = waiters.filter((w) => !w());
		}
	}
});

function send(method, params) {
	const id = nextId++;
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
	child.stdin.write(`Content-Length: ${body.length}\r\n\r\n${body}`);
	return new Promise((resolveP, reject) => pending.set(id, { resolve: resolveP, reject }));
}

function notify(method, params) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }));
	child.stdin.write(`Content-Length: ${body.length}\r\n\r\n${body}`);
}

function waitForNotification(method, timeoutMs = 20000, predicate = () => true) {
	const existing = notifications.find((n) => n.method === method && predicate(n));
	if (existing) return Promise.resolve(existing);
	return new Promise((resolveP, reject) => {
		const timer = setTimeout(() => {
			waiters = waiters.filter((w) => w.poll !== check);
			reject(new Error(`timeout waiting for ${method}\nserver stderr:\n${stderr.slice(-2000)}`));
		}, timeoutMs);
		const check = () => {
			const hit = notifications.find((n) => n.method === method && predicate(n));
			if (hit) {
				clearTimeout(timer);
				resolveP(hit);
				return true;
			}
			return false;
		};
		check.poll = check;
		waiters.push(check);
	});
}

// --- contract exercise -------------------------------------------------------

let failures = 0;
function check(desc, ok, detail = "") {
	if (ok) console.log(`ok    ${desc}`);
	else {
		failures++;
		console.error(`FAIL  ${desc}${detail ? `: ${detail}` : ""}`);
	}
}

const docText = readFileSync(targetDoc, "utf8");
const docUri = `file://${targetDoc}`;

try {
	const init = await send("initialize", {
		processId: process.pid,
		rootUri: `file://${vault}`,
		capabilities: {
			general: { positionEncodings: ["utf-16"] },
			textDocument: {
				synchronization: { dynamicRegistration: false, didSave: false },
				completion: { completionItem: { snippetSupport: false } },
				hover: { contentFormat: ["markdown"] },
			},
		},
	});
	check("initialize", init?.serverInfo?.name === "notist", JSON.stringify(init?.serverInfo));
	check(
		"FULL sync capability",
		init?.capabilities?.textDocumentSync === 1,
		`textDocumentSync=${init?.capabilities?.textDocumentSync}`,
	);
	const experimental = init?.capabilities?.experimental?.notist ?? {};
	check("renderDocument capability", typeof experimental.renderDocument === "object");
	check("documentReferences capability", typeof experimental.documentReferences === "object");
	notify("initialized", {});

	// FULL sync: exactly one range-less full-text change.
	notify("textDocument/didOpen", {
		textDocument: { uri: docUri, languageId: "notist", version: 1, text: docText },
	});
	const diag = await waitForNotification(
		"textDocument/publishDiagnostics",
		30000,
		(n) => n.params.uri === docUri,
	);
	check("publishDiagnostics pushed", Array.isArray(diag.params.diagnostics));

	const hover = await send("textDocument/hover", {
		textDocument: { uri: docUri },
		position: firstTargetPosition(docText),
	});
	check("hover", hover !== null && hover.contents !== undefined, JSON.stringify(hover));

	const completion = await send("textDocument/completion", {
		textDocument: { uri: docUri },
		position: { line: 0, character: 0 },
	});
	check(
		"completion returns array",
		completion === null || Array.isArray(completion) || Array.isArray(completion.items),
	);

	// Experimental: render the module owning the doc.
	const render = await send("notist/renderDocument", {
		textDocument: { uri: docUri },
	});
	check(
		"renderDocument page",
		render?.page?.fragment?.length > 0,
		`page=${render?.page ? "object" : JSON.stringify(render?.page)}`,
	);
	check(
		"renderDocument revision",
		typeof render?.revision === "number",
		`revision=${render?.revision}`,
	);

	const refs = await send("notist/documentReferences", {
		textDocument: { uri: docUri },
		direction: "both",
		includeDefinition: true,
	});
	check(
		"documentReferences items",
		refs !== null && Array.isArray(refs.items),
		`items=${refs?.items?.length}`,
	);
	if (refs?.items?.length > 0) {
		const item = refs.items[0];
		check(
			"reference item shape",
			typeof item.uri === "string" &&
				typeof item.range?.start?.line === "number" &&
				typeof item.isDefinition === "boolean",
		);
	}

	// FULL-sync didChange with exactly one range-less change.
	notify("textDocument/didChange", {
		textDocument: { uri: docUri, version: 2 },
		contentChanges: [{ text: docText }],
	});
	await send("shutdown", null);
	notify("exit", null);
	child.stdin.end();
} catch (err) {
	failures++;
	console.error(`FAIL  ${err.message}`);
	child.kill("SIGKILL");
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log(`\nnotist lsp contract: all checks passed (${notist})`);

/** Position just inside the first `#<target>` literal (hover resolves
 * references; plain words legitimately return null). */
function firstTargetPosition(text) {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const col = lines[i].indexOf("#<");
		if (col >= 0) return { line: i, character: col + 2 };
	}
	return { line: 0, character: 0 };
}
