import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
	R2Bucket,
	R2ObjectBody
} from '../../src/lib/server/cloudflare';
import type { PosBindings } from '../../src/lib/server/env';

type QueryRow = Record<string, unknown>;
type SQLValue = string | number | bigint | Uint8Array | null;

type StoredObject = {
	body: Uint8Array;
	httpMetadata: {
		contentType?: string;
		cacheControl?: string;
		contentDisposition?: string;
		contentEncoding?: string;
		contentLanguage?: string;
		contentLength?: number;
		cacheExpiry?: Date;
	};
	customMetadata: Record<string, string>;
	etag: string;
};

class TestPreparedStatement {
	constructor(
		private database: DatabaseSync,
		private query: string,
		private values: SQLValue[] = []
	) {}

	bind(...values: unknown[]) {
		return new TestPreparedStatement(this.database, this.query, values as SQLValue[]);
	}

	async first<T = Record<string, unknown>>(columnName?: string) {
		const statement = this.database.prepare(this.query);
		const row = (statement.get(...this.values) as QueryRow | undefined) ?? null;

		if (!row) {
			return null;
		}

		return columnName ? ((row[columnName] as T) ?? null) : (row as T);
	}

	async all<T = Record<string, unknown>>() {
		const statement = this.database.prepare(this.query);
		const rows = statement.all(...this.values) as T[];

		return createResult(rows, 0, 0);
	}

	async run<T = Record<string, unknown>>() {
		const statement = this.database.prepare(this.query);
		const result = statement.run(...this.values);

		return createResult<T>([], Number(result.changes ?? 0), Number(result.lastInsertRowid ?? 0));
	}

	async raw<T = unknown[]>(options?: { columnNames?: boolean }) {
		const statement = this.database.prepare(this.query);
		const rows = statement.all(...this.values) as QueryRow[];
		const columnNames = rows[0] ? Object.keys(rows[0]) : [];
		const rawRows = rows.map((row) => columnNames.map((column) => row[column])) as T[];

		if (options?.columnNames) {
			return [columnNames, ...rawRows] as [string[], ...T[]];
		}

		return rawRows;
	}

	executeBatch() {
		if (/^\s*select/i.test(this.query)) {
			return this.all();
		}

		return this.run();
	}
}

class TestSession {
	constructor(private database: DatabaseSync) {}

	prepare(query: string) {
		return new TestPreparedStatement(this.database, query) as unknown as D1PreparedStatement;
	}

	async batch<T = unknown>(statements: D1PreparedStatement[]) {
		return runBatch<T>(this.database, statements);
	}

	getBookmark() {
		return null;
	}
}

class TestD1Database {
	constructor(private database: DatabaseSync) {}

	prepare(query: string) {
		return new TestPreparedStatement(this.database, query) as unknown as D1PreparedStatement;
	}

	async batch<T = unknown>(statements: D1PreparedStatement[]) {
		return runBatch<T>(this.database, statements);
	}

	async exec(query: string) {
		this.database.exec(query);
		return {
			count: 0,
			duration: 0
		};
	}

	withSession() {
		return new TestSession(this.database);
	}

	async dump() {
		return new ArrayBuffer(0);
	}
}

class TestR2Object {
	constructor(private stored: StoredObject) {}

	get body() {
		const bytes = new Uint8Array(this.stored.body.byteLength);
		bytes.set(this.stored.body);
		return new Response(new Blob([bytes.buffer])).body;
	}

	get httpEtag() {
		return `"${this.stored.etag}"`;
	}

	writeHttpMetadata(headers: Headers) {
		if (this.stored.httpMetadata.contentType) {
			headers.set('content-type', this.stored.httpMetadata.contentType);
		}

		if (this.stored.httpMetadata.cacheControl) {
			headers.set('cache-control', this.stored.httpMetadata.cacheControl);
		}

		if (this.stored.httpMetadata.contentDisposition) {
			headers.set('content-disposition', this.stored.httpMetadata.contentDisposition);
		}
	}
}

class TestR2Bucket {
	private objects = new Map<string, StoredObject>();

	async put(
		key: string,
		value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
		options: {
			httpMetadata?: StoredObject['httpMetadata'];
			customMetadata?: Record<string, string>;
		} = {}
	) {
		const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
		this.objects.set(key, {
			body: bytes,
			httpMetadata: options.httpMetadata ?? {},
			customMetadata: options.customMetadata ?? {},
			etag: createHash('sha1').update(bytes).digest('hex')
		});
	}

	async get(key: string) {
		const stored = this.objects.get(key);
		return stored ? (new TestR2Object(stored) as unknown as R2ObjectBody) : null;
	}

	async delete(key: string) {
		this.objects.delete(key);
	}
}

export async function createTestBindings() {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON;');
	sqlite.exec(await readFile(resolve('migrations/0001_online_pos_foundation.sql'), 'utf8'));

	const env: PosBindings = {
		DB: new TestD1Database(sqlite) as unknown as D1Database,
		PRODUCT_IMAGES: new TestR2Bucket() as unknown as R2Bucket
	};

	return {
		env,
		sqlite,
		async dispose() {
			sqlite.close();
		}
	};
}

export function createPlatform(env: PosBindings): App.Platform {
	return {
		env,
		ctx: {
			waitUntil: (_promise: Promise<unknown>) => undefined,
			passThroughOnException: () => undefined
		},
		caches: {} as CacheStorage,
		cf: {}
	};
}

export function createRequestEvent(input: {
	url: string;
	platform: App.Platform;
	method?: string;
	json?: unknown;
	formData?: FormData;
	params?: Record<string, string>;
}) {
	let body: BodyInit | undefined;
	const headers = new Headers();

	if (input.formData) {
		body = input.formData;
	} else if (input.json !== undefined) {
		body = JSON.stringify(input.json);
		headers.set('content-type', 'application/json');
	}

	return {
		platform: input.platform,
		request: new Request(input.url, {
			method: input.method ?? 'GET',
			headers,
			body
		}),
		url: new URL(input.url),
		params: input.params ?? {}
	} as {
		platform: App.Platform;
		request: Request;
		url: URL;
		params: Record<string, string>;
	};
}

export function queryNumber(database: DatabaseSync, query: string, values: SQLValue[] = []) {
	const row = database.prepare(query).get(...values) as QueryRow;
	const firstValue = row ? Object.values(row)[0] : 0;
	return Number(firstValue ?? 0);
}

async function runBatch<T = unknown>(database: DatabaseSync, statements: D1PreparedStatement[]) {
	database.exec('BEGIN TRANSACTION;');

	try {
		const results: D1Result<T>[] = [];

		for (const statement of statements as unknown as TestPreparedStatement[]) {
			results.push((await statement.executeBatch()) as D1Result<T>);
		}

		database.exec('COMMIT;');
		return results;
	} catch (error) {
		database.exec('ROLLBACK;');
		throw error;
	}
}

function createResult<T>(results: T[], changes: number, lastRowId: number): D1Result<T> {
	return {
		success: true,
		results,
		meta: {
			duration: 0,
			size_after: 0,
			rows_read: results.length,
			rows_written: changes,
			last_row_id: lastRowId,
			changed_db: changes > 0,
			changes
		}
	};
}
