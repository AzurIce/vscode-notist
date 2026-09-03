/**
 * Type surface for notist's experimental LSP extensions. Everything standard
 * (INCREMENTAL sync, utf-16 positions, hover/completion/definition/references/symbols,
 * push diagnostics) is handled by vscode-languageclient off the server's
 * declared capabilities — only the `notist/*` methods need hand-written types.
 *
 * Server contract these rely on (crates/notist-cli/src/lsp.rs, 2026-09-03
 * encoding-negotiation state):
 * - INCREMENTAL sync: the server accepts the ranged edits
 *   vscode-languageclient derives from document version changes, as well as
 *   whole-document replacements and mixed batches (applied in order).
 *   Versions are informational only; changes for unopened documents are
 *   dropped server-side.
 * - Position encoding is negotiated: utf-8 is preferred, utf-16 (the spec
 *   default when undeclared) is accepted — only an explicit offer listing
 *   neither is refused (vscode-languageclient converts transparently).
 * - Position requests (hover/completion/definition/references) accept an
 *   optional `expected_fingerprint` for server-side snapshot identity
 *   checks; mismatches surface as `snapshot_changed:` errors and are
 *   retried inside the server, so this client neither sends nor handles
 *   it.
 * - Diagnostics are pushed: baseline right after initialize, then deltas.
 * - `notist/renderDocument` renders the module OWNING the document (page is
 *   null for non-.not documents or documents outside any vault); `revision`
 *   is the freshness gate; `resources[].sourcePath` is vault-absolute.
 * - `notist/documentReferences` resolves references to/from the document's
 *   owning module without a position selector.
 */

/** One rendered heading with its HTML anchor. */
export interface RenderedHeading {
	level: number;
	id: string;
	text: string;
}

/** One module root binding (compact type/value summary). */
export interface RenderedBinding {
	name: string;
	detail: string;
}

/** One resource file of the rendered module. */
export interface RenderedResource {
	moduleSegments: string[];
	name: string;
	/** "image" | "file". */
	kind: string;
	/** Vault-absolute path of the file on disk. */
	sourcePath: string;
}

export interface RenderedPage {
	moduleSegments: string[];
	/** Evaluated HTML fragment, same pipeline as `notist build`/`preview`. */
	fragment: string;
	title: string | null;
	headings: RenderedHeading[];
	bindings: RenderedBinding[];
	source: string | null;
}

export interface RenderDocumentParams {
	textDocument: { uri: string };
}

export interface RenderDocumentResult {
	revision: number;
	page: RenderedPage | null;
	resources: RenderedResource[];
}

export type ReferenceDirection = "incoming" | "outgoing" | "both";

export interface DocumentReferencesParams {
	textDocument: { uri: string };
	direction: ReferenceDirection;
	includeDefinition?: boolean;
}

export interface DocumentReferenceItem {
	uri: string;
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	direction: "incoming" | "outgoing";
	sourceModule: string;
	targetModule: string;
	targetName?: string | null;
	/** Outgoing only: "module" | "scope" | "resource". */
	targetKind?: string | null;
	url?: string | null;
	isDefinition: boolean;
}

export interface DocumentReferencesResult {
	revision: number;
	items: DocumentReferenceItem[];
}
