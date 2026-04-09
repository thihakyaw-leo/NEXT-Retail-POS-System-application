export interface D1Meta {
	duration: number;
	size_after: number;
	rows_read: number;
	rows_written: number;
	last_row_id: number;
	changed_db: boolean;
	changes: number;
	[key: string]: unknown;
}

export interface D1Result<T = unknown> {
	success: true;
	results: T[];
	meta: D1Meta;
	error?: never;
}

export interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	first<T = unknown>(columnName: string): Promise<T | null>;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
	all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
	raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
	raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
}

export interface D1DatabaseSession {
	prepare(query: string): D1PreparedStatement;
	batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
	getBookmark(): string | null;
}

export interface D1ExecResult {
	count: number;
	duration: number;
}

export interface D1Database {
	prepare(query: string): D1PreparedStatement;
	batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
	exec(query: string): Promise<D1ExecResult>;
	withSession(constraint?: string): D1DatabaseSession;
	dump(): Promise<ArrayBuffer>;
}

export interface R2HTTPMetadata {
	contentType?: string;
	cacheControl?: string;
	contentDisposition?: string;
	contentEncoding?: string;
	contentLanguage?: string;
	contentLength?: number;
	cacheExpiry?: Date;
}

export interface R2PutOptions {
	httpMetadata?: R2HTTPMetadata;
	customMetadata?: Record<string, string>;
}

export interface R2ObjectBody {
	body: ReadableStream<Uint8Array> | null;
	httpEtag: string;
	writeHttpMetadata(headers: Headers): void;
}

export interface R2Bucket {
	put(
		key: string,
		value: BodyInit | ArrayBuffer | ArrayBufferView | Blob,
		options?: R2PutOptions
	): Promise<void>;
	get(key: string): Promise<R2ObjectBody | null>;
	delete(key: string): Promise<void>;
}
