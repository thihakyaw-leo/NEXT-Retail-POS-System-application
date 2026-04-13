import { createHash } from 'node:crypto';
import { error, redirect, type Cookies, type RequestEvent } from '@sveltejs/kit';
import type { PosBindings } from '$lib/server/env';
import type { CurrentUser, StoreSummary, UserRole } from '$lib/types';

export const AUTH_COOKIE_NAME = 'pos_auth';
const TOKEN_TTL_SECONDS = 60 * 60 * 12;

type UserRow = {
	id: string;
	email: string;
	name: string;
	role: UserRole;
	store_id: string | null;
	password_hash: string;
	is_active: number;
};

type StoreRow = {
	id: string;
	name: string;
	address: string | null;
	currency_code: string;
};

type SessionClaims = {
	sub: string;
	email: string;
	name: string;
	role: UserRole;
	storeId: string | null;
	exp: number;
};

export async function authenticateUser(
	env: PosBindings,
	email: string,
	password: string
): Promise<CurrentUser | null> {
	const normalizedEmail = email.trim().toLowerCase();
	const user = await env.DB.prepare(
		`SELECT id, email, name, role, store_id, password_hash, is_active
		FROM users
		WHERE email = ?`
	)
		.bind(normalizedEmail)
		.first<UserRow>();

	if (!user || user.is_active !== 1) {
		return null;
	}

	if (hashPassword(normalizedEmail, password) !== user.password_hash) {
		return null;
	}

	return mapUserRow(user);
}

export async function issueAuthToken(env: PosBindings, user: CurrentUser) {
	const claims: SessionClaims = {
		sub: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		storeId: user.storeId,
		exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
	};
	return signJwtHs256(claims, getJwtSecret(env));
}

export async function verifyAuthToken(env: PosBindings, token: string): Promise<CurrentUser | null> {
	const claims = await verifyJwtHs256<SessionClaims>(token, getJwtSecret(env));

	if (!claims) {
		return null;
	}

	if (claims.exp * 1000 <= Date.now()) {
		return null;
	}

	return {
		id: claims.sub,
		email: claims.email,
		name: claims.name,
		role: claims.role,
		storeId: claims.storeId
	};
}

export async function loadCurrentUser(
	env: PosBindings,
	request: Request,
	cookies?: Cookies
): Promise<CurrentUser | null> {
	const token =
		cookies?.get(AUTH_COOKIE_NAME) ??
		readBearerToken(request.headers.get('authorization'));

	if (!token) {
		return null;
	}

	return verifyAuthToken(env, token);
}

export function applyAuthCookie(cookies: Cookies, token: string) {
	cookies.set(AUTH_COOKIE_NAME, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: false,
		maxAge: TOKEN_TTL_SECONDS
	});
}

export function clearAuthCookie(cookies: Cookies) {
	cookies.delete(AUTH_COOKIE_NAME, {
		path: '/'
	});
}

export function requireUser(event: RequestEvent) {
	const user = event.locals.user;

	if (!user) {
		throw error(401, 'Authentication required.');
	}

	return user;
}

export function requireRole(event: RequestEvent, roles: UserRole[]) {
	const user = requireUser(event);

	if (!roles.includes(user.role)) {
		throw error(403, 'You do not have permission to perform this action.');
	}

	return user;
}

export function requirePageUser(event: RequestEvent) {
	if (!event.locals.user) {
		throw redirect(302, '/login');
	}

	return event.locals.user;
}

export function requirePageRole(event: RequestEvent, roles: UserRole[]) {
	const user = requirePageUser(event);

	if (!roles.includes(user.role)) {
		throw error(403, 'Permission denied.');
	}

	return user;
}

export async function listAccessibleStores(
	env: PosBindings,
	user: CurrentUser
): Promise<StoreSummary[]> {
	if (user.role === 'admin') {
		const result = await env.DB.prepare(
			`SELECT id, name, address, currency_code
			FROM stores
			ORDER BY name COLLATE NOCASE ASC`
		).all<StoreRow>();

		return result.results.map(mapStoreRow);
	}

	if (!user.storeId) {
		return [];
	}

	const store = await env.DB.prepare(
		`SELECT id, name, address, currency_code
		FROM stores
		WHERE id = ?`
	)
		.bind(user.storeId)
		.first<StoreRow>();

	return store ? [mapStoreRow(store)] : [];
}

export function resolveStoreScope(
	user: CurrentUser,
	requestedStoreId: string | null | undefined,
	fallbackStoreId: string
) {
	const storeId = requestedStoreId ?? fallbackStoreId;

	if (user.role === 'admin') {
		return storeId;
	}

	if (!user.storeId || user.storeId !== storeId) {
		throw error(403, 'You cannot access another store.');
	}

	return storeId;
}

export function canManageInventory(role: UserRole) {
	return role === 'admin' || role === 'store_manager';
}

export function canApproveTransfers(role: UserRole) {
	return role === 'admin';
}

function mapUserRow(row: UserRow): CurrentUser {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		role: row.role,
		storeId: row.store_id
	};
}

function mapStoreRow(row: StoreRow): StoreSummary {
	return {
		id: row.id,
		name: row.name,
		address: row.address,
		currencyCode: row.currency_code
	};
}

function hashPassword(email: string, password: string) {
	return createHash('sha256').update(`${email.trim().toLowerCase()}::${password}`).digest('hex');
}

function getJwtSecret(env: PosBindings) {
	return env.JWT_SECRET?.trim() || 'dev-next-pos-jwt-secret';
}

function readBearerToken(value: string | null) {
	if (!value) {
		return null;
	}

	const match = /^Bearer\s+(.+)$/i.exec(value);
	return match?.[1] ?? null;
}

async function signJwtHs256(payload: object, secret: string) {
	const header = {
		alg: 'HS256',
		typ: 'JWT'
	};
	const encodedHeader = encodeBase64Url(JSON.stringify(header));
	const encodedPayload = encodeBase64Url(JSON.stringify(payload));
	const signature = await signValue(`${encodedHeader}.${encodedPayload}`, secret);
	return `${encodedHeader}.${encodedPayload}.${signature}`;
}

async function verifyJwtHs256<T>(token: string, secret: string): Promise<T | null> {
	const [encodedHeader, encodedPayload, signature] = token.split('.');

	if (!encodedHeader || !encodedPayload || !signature) {
		return null;
	}

	const expected = await signValue(`${encodedHeader}.${encodedPayload}`, secret);

	if (expected !== signature) {
		return null;
	}

	try {
		return JSON.parse(decodeBase64Url(encodedPayload)) as T;
	} catch {
		return null;
	}
}

async function signValue(value: string, secret: string) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{
			name: 'HMAC',
			hash: 'SHA-256'
		},
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
	return encodeBase64Url(new Uint8Array(signature));
}

function encodeBase64Url(value: string | Uint8Array) {
	const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
	let base64 = Buffer.from(bytes).toString('base64');
	base64 = base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
	return base64;
}

function decodeBase64Url(value: string) {
	const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	return Buffer.from(padded, 'base64').toString('utf8');
}
