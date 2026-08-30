/**
 * Preview panels backed by the `notist/renderDocument` experimental LSP method.
 * The extension host only requests renders and shuttles JSON across the
 * webview boundary — fragment rewriting (resource URLs onto webview URIs,
 * module anchors onto resolvable vault paths), scroll preservation across
 * re-renders and click interception all live in the webview script below,
 * mirroring what obsidian-notist does inside its iframe document.
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
import type { RenderDocumentResult, RenderedResource } from "./protocol";

/** Outcome of one render attempt, already reduced to user-presentable shape. */
export type RenderOutcome =
	| { ok: true; result: RenderDocumentResult }
	| { ok: false; message: string };

export type RenderFn = (
	uri: vscode.Uri,
	token: vscode.CancellationToken,
) => Promise<RenderOutcome>;

interface PanelEntry {
	panel: vscode.WebviewPanel;
	uri: vscode.Uri;
	/** Last posted payload (update or notice), replayed when the webview
	 * (re)loads and announces `ready` — postMessage is silently dropped while
	 * the webview document is still loading, so the first render would
	 * otherwise race the load and leave the panel blank. */
	pending: Record<string, unknown> | null;
	debounce: NodeJS.Timeout | undefined;
	cancels: vscode.CancellationTokenSource;
}

export class PreviewManager implements vscode.Disposable {
	private readonly entries = new Map<string, PanelEntry>();
	private styleCss: string | null = null;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly render: RenderFn,
	) {
		context.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument((event) =>
				this.onDocumentChanged(event),
			),
			vscode.window.onDidChangeActiveColorTheme(() => this.retheme()),
		);
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
		const data = message as { type?: string; path?: unknown };
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

		const payload = {
			type: "update",
			fragment: result.page.fragment,
			pageSegments: result.page.moduleSegments,
			resources: this.resourceMap(entry.panel.webview, result),
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

	private post(entry: PanelEntry, payload: Record<string, unknown>): void {
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
	}

	window.addEventListener('message', function (event) {
		var message = event.data;
		if (!message || typeof message !== 'object') return;
		if (message.type === 'update') apply(message);
		else if (message.type === 'notice') {
			notice.textContent = message.text;
			notice.hidden = false;
		}
	});

	document.addEventListener('click', function (event) {
		var target = event.target;
		var anchor = target && target.closest ? target.closest('a[data-notist-module]') : null;
		if (!anchor) return;
		event.preventDefault();
		vscode.postMessage({ type: 'openModule', path: anchor.getAttribute('data-notist-module') });
	});

	// Announce readiness: the host replays the latest payload, which covers
	// messages dropped while this document was still loading.
	vscode.postMessage({ type: 'ready' });
}());
`;
}
