/**
 * Preview panels backed by the `notist/renderDocument` experimental LSP method.
 * The extension host only requests renders and shuttles JSON across the
 * webview boundary — fragment rewriting (resource URLs onto webview URIs,
 * module anchors onto resolvable vault paths), scroll preservation across
 * re-renders and click interception all live in the webview script below,
 * mirroring what obsidian-notist does inside its iframe document.
 *
 * Scroll sync and click-to-source follow the tinymist approach: the renderer
 * tags every block element with `data-notist-start`/`-end` (UTF-8 byte offsets
 * into the module source, see crates/notist-html range_attributes_range), so
 * the host only needs a byte↔LSP-position conversion (src/source-map.ts) and
 * the webview keeps a byte→offsetTop index over those attributes. No upstream
 * changes, element-accurate in both directions.
 *
 * The vendored site stylesheet (assets/site/style.css) makes the panel show
 * literally what `notist build`/`notist preview` would produce, wrapped in
 * the site's `.page-body > .page-main > article.notist-document` shell.
 *
 * Known gap vs the preview site: plugin web components (mermaid 等) are not
 * loaded — fragments that need them render unenhanced.
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import { SourceMap } from "./source-map";
import type { RenderDocumentResult, RenderedResource } from "./protocol";

/** Outcome of one render attempt, already reduced to user-presentable shape. */
export type RenderOutcome =
	| { ok: true; result: RenderDocumentResult }
	| { ok: false; message: string };

export type RenderFn = (
	uri: vscode.Uri,
	token: vscode.CancellationToken,
) => Promise<RenderOutcome>;

/** Everything the host can post into the webview. Only `update`/`notice`
 * become `pending` (replayed when the webview loads); `config`/`scrollToByte`
 * are fire-and-forget. */
type PanelPayload =
	| {
			type: "update";
			fragment: string;
			pageSegments: string[];
			resources: Record<string, string>;
			clickToSource: boolean;
	  }
	| { type: "notice"; text: string }
	| { type: "config"; clickToSource: boolean }
	| { type: "scrollToByte"; byte: number };

interface PanelEntry {
	panel: vscode.WebviewPanel;
	uri: vscode.Uri;
	/** Last posted `update`/`notice` payload, replayed when the webview
	 * (re)loads and announces `ready` — postMessage is silently dropped while
	 * the webview document is still loading, so the first render would
	 * otherwise race the load and leave the panel blank. */
	pending: PanelPayload | null;
	debounce: NodeJS.Timeout | undefined;
	cancels: vscode.CancellationTokenSource;
}

const toPosition = (p: { line: number; character: number }): vscode.Position =>
	new vscode.Position(p.line, p.character);

export class PreviewManager implements vscode.Disposable {
	private readonly entries = new Map<string, PanelEntry>();
	/** uri → byte↔position map, invalidated by document version. */
	private readonly sourceMaps = new Map<string, { version: number; map: SourceMap }>();
	/** While non-zero, editor visible-range events are echo of our own
	 * preview→editor reveal and must not scroll the preview back. */
	private editorSyncLockUntil = 0;
	private styleCss: string | null = null;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly render: RenderFn,
	) {
		context.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument((event) =>
				this.onDocumentChanged(event),
			),
			vscode.window.onDidChangeTextEditorVisibleRanges((event) =>
				this.onEditorScrolled(event),
			),
			vscode.workspace.onDidChangeConfiguration((event) =>
				this.onConfigChanged(event),
			),
			vscode.window.onDidChangeActiveColorTheme(() => this.retheme()),
		);
	}

	private cfgBool(
		name: "scrollPreviewWithEditor" | "scrollEditorWithPreview" | "clickToSource",
		fallback: boolean,
	): boolean {
		return vscode.workspace.getConfiguration("notist").get(`preview.${name}`, fallback);
	}

	/** Byte↔position map for the live document, cached per version. */
	private sourceMap(doc: vscode.TextDocument): SourceMap | null {
		const key = doc.uri.toString();
		const cached = this.sourceMaps.get(key);
		if (cached !== undefined && cached.version === doc.version) return cached.map;
		const map = SourceMap.fromText(doc.getText());
		this.sourceMaps.set(key, { version: doc.version, map });
		return map;
	}

	/** Editor scrolled → scroll the preview to the element owning the first
	 * visible source byte. */
	private onEditorScrolled(event: vscode.TextEditorVisibleRangesChangeEvent): void {
		const entry = this.entries.get(event.textEditor.document.uri.toString());
		if (entry === undefined || entry.pending?.type !== "update") return;
		if (!this.cfgBool("scrollPreviewWithEditor", true)) return;
		if (Date.now() < this.editorSyncLockUntil) return;
		const top = event.visibleRanges[0]?.start;
		if (top === undefined) return;
		const map = this.sourceMap(event.textEditor.document);
		if (map === null) return;
		this.post(entry, {
			type: "scrollToByte",
			byte: map.byteOfPosition({ line: top.line, character: top.character }),
		});
	}

	private onConfigChanged(event: vscode.ConfigurationChangeEvent): void {
		if (!event.affectsConfiguration("notist.preview")) return;
		const payload: PanelPayload = {
			type: "config",
			clickToSource: this.cfgBool("clickToSource", true),
		};
		for (const entry of this.entries.values()) {
			this.post(entry, payload);
		}
	}

	dispose(): void {
		for (const entry of this.entries.values()) {
			entry.panel.dispose();
		}
		this.entries.clear();
	}

	open(target: vscode.Uri, toSide: boolean): void {
		const key = target.toString();
		const existing = this.entries.get(key);
		if (existing) {
			void existing.panel.reveal(toSide ? vscode.ViewColumn.Two : vscode.ViewColumn.Beside);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			"notist.preview",
			`Preview: ${target.path.split("/").pop() ?? target.path}`,
			{
				viewColumn: toSide ? vscode.ViewColumn.Two : vscode.ViewColumn.Beside,
				preserveFocus: true,
			},
			{
				enableScripts: true,
				localResourceRoots: this.localResourceRoots(),
			},
		);

		const entry: PanelEntry = {
			panel,
			uri: target,
			pending: null,
			debounce: undefined,
			cancels: new vscode.CancellationTokenSource(),
		};
		this.entries.set(key, entry);

		panel.webview.html = this.composeShell(panel.webview);
		panel.webview.onDidReceiveMessage(
			(message) => this.onPanelMessage(entry, message),
			undefined,
			this.context.subscriptions,
		);
		panel.onDidDispose(() => {
			entry.cancels.cancel();
			if (entry.debounce !== undefined) clearTimeout(entry.debounce);
			this.entries.delete(key);
			this.sourceMaps.delete(key);
		});
		void this.renderInto(entry);
	}

	private localResourceRoots(): vscode.Uri[] {
		const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
		roots.push(this.context.extensionUri);
		return roots;
	}

	private onPanelMessage(entry: PanelEntry, message: unknown): void {
		if (typeof message !== "object" || message === null) return;
		const data = message as {
			type?: string;
			path?: unknown;
			byte?: unknown;
			start?: unknown;
			end?: unknown;
		};
		if (data.type === "openModule" && typeof data.path === "string") {
			void this.openModulePath(data.path);
			return;
		}
		if (data.type === "ready") {
			// The webview script just installed its listeners; anything we
			// posted earlier may have been dropped mid-load — replay it.
			if (entry.pending !== null) {
				this.post(entry, entry.pending);
			} else {
				void this.renderInto(entry);
			}
			return;
		}
		if (data.type === "jumpToSource") {
			const start = data.start;
			const end = data.end;
			if (typeof start === "number" && Number.isFinite(start)) {
				const endByte = typeof end === "number" && Number.isFinite(end) ? end : start;
				void this.revealSource(entry, start, Math.max(start, endByte), "center");
			}
			return;
		}
		if (data.type === "previewScrolled") {
			const byte = data.byte;
			if (typeof byte !== "number" || !Number.isFinite(byte)) return;
			if (!this.cfgBool("scrollEditorWithPreview", true)) return;
			// The reveal below echoes back as a visible-range change; lock the
			// editor→preview direction out of it.
			this.editorSyncLockUntil = Date.now() + 250;
			const doc = vscode.workspace.textDocuments.find(
				(d) => d.uri.toString() === entry.uri.toString(),
			);
			if (doc === undefined) return;
			const pos = this.sourceMap(doc)?.position(byte);
			if (pos === undefined) return;
			const editor = vscode.window.visibleTextEditors.find(
				(e) => e.document.uri.toString() === entry.uri.toString(),
			);
			// Viewport only — no selection, no focus steal.
			editor?.revealRange(new vscode.Range(toPosition(pos), toPosition(pos)), vscode.TextEditorRevealType.AtTop);
		}
	}

	/** Preview click → reveal the element's source range. Only moves the
	 * viewport (and the cursor when the editor is visible), never focus. */
	private async revealSource(
		entry: PanelEntry,
		startByte: number,
		endByte: number,
		behavior: "center" | "top",
	): Promise<void> {
		const doc = await vscode.workspace.openTextDocument(entry.uri);
		const map = this.sourceMap(doc);
		if (map === null) return;
		const start = map.position(startByte);
		const range = new vscode.Range(
			toPosition(start),
			toPosition(map.position(Math.max(startByte, endByte))),
		);
		const editor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.toString() === entry.uri.toString(),
		);
		if (editor !== undefined) {
			editor.selection = new vscode.Selection(toPosition(start), toPosition(start));
			editor.revealRange(
				range,
				behavior === "center"
					? vscode.TextEditorRevealType.InCenterIfOutsideViewport
					: vscode.TextEditorRevealType.AtTop,
			);
		} else {
			await vscode.window.showTextDocument(doc, {
				selection: new vscode.Selection(toPosition(start), toPosition(start)),
				preserveFocus: true,
			});
		}
	}

	/** `<dir>.not` / `<dir>/README.not` candidates under every workspace folder. */
	private async openModulePath(path: string): Promise<void> {
		const candidates = path
			? [`${path}.not`, `${path}/README.not`]
			: ["README.not"];
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			for (const candidate of candidates) {
				const uri = vscode.Uri.joinPath(folder.uri, ...candidate.split("/"));
				try {
					const stat = await vscode.workspace.fs.stat(uri);
					if (stat.type & vscode.FileType.File) {
						await vscode.window.showTextDocument(uri);
						return;
					}
				} catch {
					// missing candidate — keep looking
				}
			}
		}
		void vscode.window.showInformationMessage(
			`Notist: cannot resolve module "${path || "<vault root>"}"`,
		);
	}

	private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
		const entry = this.entries.get(event.document.uri.toString());
		if (!entry || event.document.languageId !== "notist") return;
		const debounceMs = vscode.workspace
			.getConfiguration("notist")
			.get<number>("preview.debounceMs", 500);
		if (entry.debounce !== undefined) clearTimeout(entry.debounce);
		entry.debounce = setTimeout(() => {
			entry.debounce = undefined;
			void this.renderInto(entry);
		}, debounceMs);
	}

	private async renderInto(entry: PanelEntry): Promise<void> {
		entry.cancels.cancel();
		const source = new vscode.CancellationTokenSource();
		entry.cancels = source;

		const outcome = await this.render(entry.uri, source.token);
		if (source.token.isCancellationRequested) return;

		if (!outcome.ok) {
			entry.pending = { type: "notice", text: outcome.message };
			this.post(entry, entry.pending);
			return;
		}
		const { result } = outcome;
		if (result.page === null) {
			entry.pending = {
				type: "notice",
				text: "This document is not part of a Notist vault (no Notist.toml above it).",
			};
			this.post(entry, entry.pending);
			return;
		}

		const payload: PanelPayload = {
			type: "update",
			fragment: result.page.fragment,
			pageSegments: result.page.moduleSegments,
			resources: this.resourceMap(entry.panel.webview, result),
			clickToSource: this.cfgBool("clickToSource", true),
		};
		entry.pending = payload;
		this.post(entry, payload);
		if (result.page.title) {
			entry.panel.title = `Preview: ${result.page.title}`;
		}
	}

	/** Key = decoded site-path segments joined (`moduleSegments/name`), matching
	 * how the webview script decomposes fragment URLs. */
	private resourceMap(
		webview: vscode.Webview,
		result: RenderDocumentResult,
	): Record<string, string> {
		const map: Record<string, string> = {};
		for (const resource of result.resources) {
			const uri = this.resourceUri(resource);
			if (uri === null) continue;
			const key = [...resource.moduleSegments, resource.name].join("/");
			map[key] = webview.asWebviewUri(uri).toString();
		}
		return map;
	}

	private resourceUri(resource: RenderedResource): vscode.Uri | null {
		const raw = resource.sourcePath;
		if (raw.length === 0) return null;
		if (raw.startsWith("/")) return vscode.Uri.file(raw);
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const uri = vscode.Uri.joinPath(folder.uri, raw);
			try {
				if (fs.statSync(uri.fsPath).isFile()) return uri;
			} catch {
				// try next folder
			}
		}
		return null;
	}

	private post(entry: PanelEntry, payload: PanelPayload): void {
		void entry.panel.webview.postMessage(payload);
	}

	private themeClass(): string {
		const kind = vscode.window.activeColorTheme.kind;
		return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
			? "theme-dark"
			: "theme-light";
	}

	/** Theme switches rebuild the shell (full html reassign) and replay the
	 * last payload so content+scroll come back. */
	private retheme(): void {
		for (const entry of this.entries.values()) {
			entry.panel.webview.html = this.composeShell(entry.panel.webview);
			if (entry.pending !== null) this.post(entry, entry.pending);
		}
	}

	private loadStyleCss(): string {
		if (this.styleCss === null) {
			const uri = vscode.Uri.joinPath(this.context.extensionUri, "assets/site/style.css");
			this.styleCss = fs.readFileSync(uri.fsPath, "utf8");
		}
		return this.styleCss;
	}

	private composeShell(webview: vscode.Webview): string {
		const nonce = getNonce();
		const csp = webview.cspSource;
		const theme = this.themeClass();
		// The site stylesheet keys manual theming off [data-theme] on <html>
		// (:root[data-theme="dark"] carries the full dark palette) — setting it
		// makes the preview follow the EDITOR theme instead of the OS-level
		// prefers-color-scheme the media queries would see.
		const dataTheme = theme === "theme-dark" ? "dark" : "light";
		return [
			"<!DOCTYPE html>",
			`<html class="${theme}" data-theme="${dataTheme}">`,
			"<head>",
			'<meta charset="utf-8">',
			`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; media-src ${csp}; font-src ${csp} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`,
			`<style>${this.loadStyleCss()}</style>`,
			// The site reserves a fixed topbar via a narrow-viewport body rule;
			// the editor preview has no topbar.
			"<style>body { padding-top: 0; }</style>",
			"<style>",
			"#notist-notice { position: fixed; inset: auto 1rem 1rem 1rem; padding: 0.5rem 0.75rem;",
			"  border-radius: 4px; background: var(--vscode-editorWidget-background, #252526);",
			"  color: var(--vscode-editorWidget-foreground, #cccccc);",
			"  border: 1px solid var(--vscode-editorWidget-border, #454545); font-size: 12px; }",
			"</style>",
			"</head>",
			`<body class="${theme}">`,
			'<div class="page-body">',
			'<main class="page-main" id="page-content">',
			'<article class="notist-document" id="notist-article"></article>',
			"</main>",
			"</div>",
			'<div id="notist-notice" hidden></div>',
			`<script nonce="${nonce}">${webviewScript()}</script>`,
			"</body>",
			"</html>",
		].join("\n");
	}
}

function getNonce(): string {
	let text = "";
	const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

/**
 * The webview-side half: fragment swapping with scroll preservation, URL
 * rewriting (see obsidian-notist/src/preview.ts decodeUrl rules — fragment
 * URLs decode, segment by segment, onto vault paths; '..' segments only ever
 * appear on module-page anchors), and module-anchor click interception.
 * Plain ES5 — no template literals, so the outer file can interpolate freely.
 */
function webviewScript(): string {
	return `
(function () {
	'use strict';
	var vscode = acquireVsCodeApi();
	var article = document.getElementById('notist-article');
	var notice = document.getElementById('notist-notice');

	// Scroll-sync index over [data-notist-start] (UTF-8 byte offsets into the
	// module source, emitted by the notist-html renderer): byte→top for
	// editor-driven scrolls, top→byte for preview-driven ones.
	var index = [];
	var byTop = [];
	var suppressScrollUntil = 0;
	var scrollScheduled = false;
	var clickToSource = false;

	function rebuildIndex() {
		index.length = 0;
		var els = article.querySelectorAll('[data-notist-start]');
		var currentScroll = window.pageYOffset || 0;
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			var b = parseInt(el.getAttribute('data-notist-start'), 10);
			if (isNaN(b)) continue;
			index.push({ byte: b, top: el.getBoundingClientRect().top + currentScroll });
		}
		index.sort(function (a, b) { return a.byte - b.byte; });
		byTop = index.slice().sort(function (a, b) { return a.top - b.top; });
	}

	function topForByte(byte) {
		if (index.length === 0) return null;
		if (byte <= index[0].byte) return index[0].top;
		var last = index[index.length - 1];
		if (byte >= last.byte) return last.top;
		var lo = 0;
		var hi = index.length - 1;
		while (lo < hi) {
			var mid = (lo + hi + 1) >> 1;
			if (index[mid].byte <= byte) lo = mid;
			else hi = mid - 1;
		}
		var a = index[lo];
		var b = index[Math.min(lo + 1, index.length - 1)];
		var span = b.byte - a.byte;
		if (span <= 0) return a.top;
		return a.top + (b.top - a.top) * ((byte - a.byte) / span);
	}

	function byteAtViewportTop() {
		if (byTop.length === 0) return null;
		var top = window.pageYOffset || 0;
		for (var i = 0; i < byTop.length; i++) {
			if (byTop[i].top >= top) return byTop[i].byte;
		}
		return byTop[byTop.length - 1].byte;
	}

	function decodeUrl(url) {
		var withoutHash = url.split('#')[0];
		if (/^(https?|data|blob|mailto|file):/i.test(withoutHash)) return null;
		if (withoutHash === '' || withoutHash === '#') return null;
		var isModulePage = withoutHash.charAt(withoutHash.length - 1) === '/';
		var raw = withoutHash.split('/');
		var segments = [];
		for (var i = 0; i < raw.length; i++) {
			if (raw[i] === '') continue;
			try {
				segments.push(decodeURIComponent(raw[i]));
			} catch (e) {
				return null;
			}
		}
		return { segments: segments, isModulePage: isModulePage };
	}

	function rewrite(root, payload) {
		var resources = payload.resources || {};

		function rewriteAttr(el, attr) {
			var url = el.getAttribute(attr);
			if (!url) return;
			var decoded = decodeUrl(url);
			if (!decoded || decoded.isModulePage) return;
			var segments = decoded.segments.slice();
			var name = segments.pop();
			if (name === undefined) return;
			var mapped = resources[segments.concat([name]).join('/')];
			if (mapped) el.setAttribute(attr, mapped);
		}

		var media = root.querySelectorAll('img[src],video[src],audio[src],source[src]');
		for (var i = 0; i < media.length; i++) rewriteAttr(media[i], 'src');

		var anchors = root.querySelectorAll('a[href]');
		for (var j = 0; j < anchors.length; j++) {
			var a = anchors[j];
			var href = a.getAttribute('href');
			if (!href) continue;
			var decoded = decodeUrl(href);
			if (!decoded) continue;
			if (decoded.isModulePage) {
				// Resolve the site-relative module URL against this page's own
				// module segments; the extension opens <dir>.not / <dir>/README.not.
				var resolved = (payload.pageSegments || []).slice();
				var ok = true;
				for (var k = 0; k < decoded.segments.length; k++) {
					var seg = decoded.segments[k];
					if (seg === '..') {
						if (resolved.length === 0) { ok = false; break; }
						resolved.pop();
					} else {
						resolved.push(seg);
					}
				}
				if (ok) a.setAttribute('data-notist-module', resolved.join('/'));
			} else {
				rewriteAttr(a, 'href');
			}
		}
	}

	function apply(payload) {
		if (!payload || typeof payload.fragment !== 'string') return;
		notice.hidden = true;
		var scroller = document.scrollingElement;
		var top = scroller ? scroller.scrollTop : 0;
		article.innerHTML = payload.fragment;
		rewrite(article, payload);
		if (scroller) scroller.scrollTop = top;
		if (typeof payload.clickToSource === 'boolean') clickToSource = payload.clickToSource;
		rebuildIndex();
	}

	window.addEventListener('message', function (event) {
		var message = event.data;
		if (!message || typeof message !== 'object') return;
		if (message.type === 'update') apply(message);
		else if (message.type === 'notice') {
			notice.textContent = message.text;
			notice.hidden = false;
		} else if (message.type === 'config') {
			if (typeof message.clickToSource === 'boolean') clickToSource = message.clickToSource;
		} else if (message.type === 'scrollToByte') {
			if (typeof message.byte !== 'number') return;
			var target = topForByte(message.byte);
			if (target === null) return;
			// Our own scroll event would echo back as previewScrolled.
			suppressScrollUntil = Date.now() + 250;
			window.scrollTo(0, target);
		}
	});

	// Preview scrolled by the user → report the byte at the viewport top.
	window.addEventListener('scroll', function () {
		if (Date.now() < suppressScrollUntil || scrollScheduled) return;
		scrollScheduled = true;
		requestAnimationFrame(function () {
			scrollScheduled = false;
			var byte = byteAtViewportTop();
			if (byte === null) return;
			vscode.postMessage({ type: 'previewScrolled', byte: byte });
		});
	});

	document.addEventListener('click', function (event) {
		var target = event.target;
		var anchor = target && target.closest ? target.closest('a[data-notist-module]') : null;
		if (anchor) {
			event.preventDefault();
			vscode.postMessage({ type: 'openModule', path: anchor.getAttribute('data-notist-module') });
			return;
		}
		if (!clickToSource || !target || !target.closest) return;
		// Real links keep their behavior; selecting text is not a jump.
		if (event.defaultPrevented || target.closest('a[href]')) return;
		var selection = window.getSelection();
		if (selection && String(selection).length > 0) return;
		var el = target.closest('[data-notist-start]');
		if (!el) return;
		var start = parseInt(el.getAttribute('data-notist-start'), 10);
		if (isNaN(start)) return;
		var end = parseInt(el.getAttribute('data-notist-end'), 10);
		vscode.postMessage({
			type: 'jumpToSource',
			start: start,
			end: isNaN(end) ? start : end,
		});
	});

	// Announce readiness: the host replays the latest payload, which covers
	// messages dropped while this document was still loading.
	vscode.postMessage({ type: 'ready' });
}());
`;
}
