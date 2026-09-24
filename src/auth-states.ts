import { randomBytes } from 'node:crypto';

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * One-time `state` values for the WHOOP authorization flow. get_auth_url issues one,
 * /callback consumes it, so a callback that this server did not start is rejected.
 */
export class PendingAuthStates {
	private readonly states = new Map<string, number>();

	issue(): string {
		this.prune();
		const state = randomBytes(24).toString('base64url');
		this.states.set(state, Date.now() + STATE_TTL_MS);
		return state;
	}

	consume(state: string | undefined): boolean {
		if (!state) return false;
		const expiresAt = this.states.get(state);
		this.states.delete(state);
		return expiresAt !== undefined && expiresAt > Date.now();
	}

	private prune(): void {
		const now = Date.now();
		for (const [state, expiresAt] of this.states) {
			if (expiresAt <= now) this.states.delete(state);
		}
	}
}
