/**
 * vscode-notist activation: language server lifecycle, commands, and the
 * bridges into notist's experimental LSP methods (renderDocument → preview,
 * documentReferences → reference browser).
 *
 * Client contract notes (see src/protocol.ts for the server-side rationale):
 * - vscode-languageclient honors the server's FULL textDocumentSync: every
 *   didChange carries exactly one range-less full-text change with a
 *   monotonic version, which is exactly what `notist lsp` demands (violations
 *   are silently dropped server-side, so the library's discipline is the guard).
 * - Position encoding defaults to utf-16, which the server picks when offered.
 * - Diagnostics arrive pushed via textDocument/publishDiagnostics and land in
 *   VS Code's Problems panel with no extra wiring.
 * - The server consumes no initializationOptions/settings; configuration only
 *   affects how we spawn it, hence the manual restart command.
 */
import * as vscode from "vscode";
import {
	LanguageClient,
	type LanguageClientOptions,
	type ServerOptions,
} from "vscode-languageclient/node";
import { PreviewManager, type RenderFn, type RenderOutcome } from "./preview";
import type {
	DocumentReferencesParams,
	DocumentReferencesResult,
	ReferenceDirection,
	RenderDocumentParams,
	RenderDocumentResult,
} from "./protocol";

export function activate(context: vscode.ExtensionContext): void {
	let client: LanguageClient | undefined;
	/** Resolves true once initialize finished; false if startup failed. */
	let ready: Promise<boolean> = Promise.resolve(false);

	const startServer = (): void => {
		client = createClient();
		ready = client
			.start()
			.then(() => true)
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(
					`Notist language server failed to start (${message}). ` +
						`Check notist.server.command — it must be able to run \`notist lsp\`.`,
				);
				return false;
			});
	};

	const stopServer = async (): Promise<void> => {
		if (client === undefined) return;
		const current = client;
		client = undefined;
		try {
			await current.stop();
		} catch {
			// already stopped or crashed — nothing to do
		}
	};

	startServer();
	context.subscriptions.push({ dispose: () => void client?.stop() });

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("notist.server")) {
				void (async () => {
					await stopServer();
					startServer();
				})();
			}
		}),
	);

	const render: RenderFn = async (uri, token): Promise<RenderOutcome> => {
		if (!(await ready)) {
			return { ok: false, message: "The Notist language server is not running." };
		}
		if (client === undefined) {
			return { ok: false, message: "The Notist language server is not running." };
		}
		const params: RenderDocumentParams = { textDocument: { uri: uri.toString(true) } };
		try {
			const result = await client.sendRequest<RenderDocumentResult>(
				"notist/renderDocument",
				params,
				token,
			);
			return { ok: true, result };
		} catch (err) {
			if (token.isCancellationRequested) {
				return { ok: false, message: "cancelled" };
			}
			return { ok: false, message: renderErrorMessage(err) };
		}
	};

	const previews = new PreviewManager(context, render);

	const activeNotistDocument = (): vscode.TextDocument | undefined => {
		const doc = vscode.window.activeTextEditor?.document;
		return doc !== undefined && doc.languageId === "notist" ? doc : undefined;
	};

	context.subscriptions.push(
		previews,
		vscode.commands.registerCommand("notist.showPreview", () => {
			const doc = activeNotistDocument();
			if (doc === undefined) {
				void vscode.window.showInformationMessage("Open a .not document to preview it.");
				return;
			}
			previews.open(doc.uri, false);
		}),
		vscode.commands.registerCommand("notist.showPreviewToSide", () => {
			const doc = activeNotistDocument();
			if (doc === undefined) {
				void vscode.window.showInformationMessage("Open a .not document to preview it.");
				return;
			}
			previews.open(doc.uri, true);
		}),
		vscode.commands.registerCommand("notist.restartServer", () => {
			void (async () => {
				await stopServer();
				startServer();
				void vscode.window.showInformationMessage("Notist language server restarted.");
			})();
		}),
		vscode.commands.registerCommand("notist.showDocumentReferences", () => {
			void showDocumentReferences(() => ready, () => client);
		}),
	);
}

function renderErrorMessage(err: unknown): string {
	const code = typeof err === "object" && err !== null && "code" in err
		? (err as { code: number | string }).code
		: undefined;
	if (code === -32601) {
		return "The language server does not support notist/renderDocument — your notist build is too old.";
	}
	const message = err instanceof Error ? err.message : String(err);
	return `Render failed: ${message}`;
}

function createClient(): LanguageClient {
	const config = vscode.workspace.getConfiguration("notist");
	const command = config.get<string>("server.command", "notist");
	const extraArgs = config
		.get<string>("server.args", "")
		.split(/\s+/)
		.filter((arg) => arg.length > 0);
	// The server canonicalizes its root from workspaceFolders[0]/rootUri and
	// routes vaults internally (nearest Notist.toml), so one process rooted at
	// the first workspace folder covers nested-vault layouts.
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const serverOptions: ServerOptions = {
		command,
		args: [...extraArgs, "lsp"],
		options: { cwd },
	};
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ language: "notist", scheme: "file" }],
		markdown: { isTrusted: true, supportHtml: true },
	};
	return new LanguageClient(
		"notist",
		"Notist Language Server",
		serverOptions,
		clientOptions,
	);
}

async function showDocumentReferences(
	ready: () => Promise<boolean>,
	client: () => LanguageClient | undefined,
): Promise<void> {
	const doc = vscode.window.activeTextEditor?.document;
	if (doc === undefined || doc.languageId !== "notist") {
		void vscode.window.showInformationMessage(
			"Open a .not document to inspect its references.",
		);
		return;
	}
	const picks: { label: string; value: ReferenceDirection }[] = [
		{ label: "$(arrow-left) incoming", value: "incoming" },
		{ label: "$(arrow-right) outgoing", value: "outgoing" },
		{ label: "$(arrow-both) both", value: "both" },
	];
	const picked = await vscode.window.showQuickPick(picks, {
		placeHolder: "Which references of this document's module?",
	});
	if (picked === undefined) return;

	const current = client();
	if (!(await ready()) || current === undefined) {
		void vscode.window.showErrorMessage("The Notist language server is not running.");
		return;
	}
	const params: DocumentReferencesParams = {
		textDocument: { uri: doc.uri.toString(true) },
		direction: picked.value,
		includeDefinition: true,
	};
	let result: DocumentReferencesResult;
	try {
		result = await current.sendRequest<DocumentReferencesResult>(
			"notist/documentReferences",
			params,
		);
	} catch (err) {
		const code = typeof err === "object" && err !== null && "code" in err
			? (err as { code: number | string }).code
			: undefined;
		const message =
			code === -32601
				? "The language server does not support notist/documentReferences — your notist build is too old."
				: `Reference lookup failed: ${err instanceof Error ? err.message : String(err)}`;
		void vscode.window.showErrorMessage(message);
		return;
	}
	if (result.items.length === 0) {
		void vscode.window.showInformationMessage("No references found.");
		return;
	}

	const arrow = (direction: string) => (direction === "incoming" ? "←" : "→");
	const items = result.items.map((item) => {
		const name = item.targetName ?? item.targetModule;
		return {
			label: `${arrow(item.direction)} ${item.isDefinition ? "$(symbol-class) " : ""}${name}`,
			description: item.isDefinition ? `${item.sourceModule} (definition)` : item.sourceModule,
			detail: item.targetKind ? `${item.targetModule} · ${item.targetKind}` : item.targetModule,
			uri: vscode.Uri.parse(item.uri),
			range: new vscode.Range(
				item.range.start.line,
				item.range.start.character,
				item.range.end.line,
				item.range.end.character,
			),
		};
	});
	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: `${items.length} reference${items.length === 1 ? "" : "s"}`,
		matchOnDescription: true,
	});
	if (selected !== undefined) {
		await vscode.window.showTextDocument(selected.uri, {
			selection: selected.range,
		});
	}
}
