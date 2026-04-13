import type { AuthLoginResponse } from '$lib/types';

const SESSION_KEY = 'pos_session';

export function saveCachedSession(session: AuthLoginResponse) {
	localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function readCachedSession(): AuthLoginResponse | null {
	const raw = localStorage.getItem(SESSION_KEY);

	if (!raw) {
		return null;
	}

	try {
		return JSON.parse(raw) as AuthLoginResponse;
	} catch {
		return null;
	}
}

export function clearCachedSession() {
	localStorage.removeItem(SESSION_KEY);
}
