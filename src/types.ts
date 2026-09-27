export interface DbOAuthCode {
	code_hash: string;
	/** Shared by this code and every token issued from it. */
	family_id: string;
	/** Sign-in generation it was issued under; only the current one is accepted (auth/provider.ts). */
	generation: string;
	client_id: string;
	code_challenge: string;
	redirect_uri: string;
	/** Space-separated, as in the OAuth `scope` parameter. */
	scopes: string;
	expires_at: number;
	consumed_at: number | null;
	/** When the owner ticked the box allowing this app to read their WHOOP data. */
	consented_at: number;
}

export interface DbOAuthToken {
	token_hash: string;
	family_id: string;
	generation: string;
	kind: 'access' | 'refresh';
	client_id: string;
	/** Space-separated, as in the OAuth `scope` parameter. */
	scopes: string;
	expires_at: number;
	/** Set when a refresh token is used; a second use means it leaked. */
	consumed_at: number | null;
}
