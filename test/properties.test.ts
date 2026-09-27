/**
 * Property-based tests: fast-check generates many inputs and shrinks any failure to a
 * minimal counterexample. On a failure it prints the seed that reproduces it. All data is
 * synthetic. The WHOOP client's own properties, including the refresh races, are in
 * packages/whoop-client/test/properties.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { cleanName, consentText, renderLoginPage } from '../src/auth/login-page.js';
import { redirectAllowed } from '../src/auth/redirects.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { isNewer } from '../src/updates.js';

process.env.ENCRYPTION_SECRET ??= 'test-encryption-secret';

// --- Versions, names, the sign-in page, redirects, encryption ------------------------------

describe('isNewer', () => {
	const version = fc.tuple(fc.nat({ max: 1000 }), fc.nat({ max: 1000 }), fc.nat({ max: 1000 }));
	const text = ([a, b, c]: number[]) => `${a}.${b}.${c}`;
	const compare = (x: number[], y: number[]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

	it('orders versions by their numbers, strictly', () => {
		fc.assert(fc.property(version, version, (x, y) => {
			assert.equal(isNewer(text(x), text(y)), compare(x, y) > 0);
			assert.equal(isNewer(`v${text(x)}`, text(y)), compare(x, y) > 0, 'a leading v is allowed');
			assert.ok(!(isNewer(text(x), text(y)) && isNewer(text(y), text(x))), 'asymmetric');
		}));
	});

	it('never calls something that is not a version newer', () => {
		fc.assert(fc.property(fc.string(), version, (junk, y) => {
			fc.pre(!/^\s*v?\d+\.\d+\.\d+\s*$/.test(junk));
			assert.equal(isNewer(junk, text(y)), false);
		}));
	});
});

describe('app names from clients', () => {
	// The characters the sign-in page and the log must never show: controls and bidirectional marks.
	const REMOVED = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
	const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

	it('are cleaned of controls and bidirectional marks, capped at 80 characters, and stay well-formed', () => {
		// Names around the 80-character cut, with characters outside the basic plane, are the tricky ones.
		const name = fc.oneof(
			fc.string({ unit: 'binary', maxLength: 200 }),
			fc.tuple(fc.string({ unit: 'binary-ascii', minLength: 70, maxLength: 85 }), fc.string({ unit: 'binary', minLength: 1, maxLength: 10 })).map(([a, b]) => a + b),
		);
		fc.assert(fc.property(name, name => {
			const cleaned = cleanName(name);
			assert.doesNotMatch(cleaned, REMOVED);
			assert.ok([...cleaned].length <= 80);
			assert.doesNotMatch(cleaned, LONE_SURROGATE, 'no half of a surrogate pair is left behind');
			assert.equal(cleanName(cleaned), cleaned, 'cleaning twice changes nothing');
		}));
	});
});

describe('the sign-in page', () => {
	const attacker = fc.string({ unit: fc.constantFrom('<', '>', '"', "'", '&', 'a', ' ', '/', '=', '\u202e'), maxLength: 20 });
	const render = (name: string, state: string, scope: string, resource: string, destination: string) =>
		renderLoginPage({
			client: { client_id: 'client', client_name: name, redirect_uris: [] } as never,
			params: { redirectUri: 'https://claude.ai/cb', codeChallenge: 'challenge', state, scopes: scope ? [scope] : [], resource: new URL(`https://mcp.example/${encodeURIComponent(resource)}`) } as never,
			destination,
		});
	const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

	it('lets nothing an app or a link controls add markup, and posts every field back unchanged', () => {
		const benign = render('x', 'x', 'x', 'x', 'x');
		const count = (html: string, char: string) => html.split(char).length - 1;
		fc.assert(fc.property(attacker, attacker, attacker, attacker, attacker, (name, state, scope, resource, destination) => {
			const html = render(name || 'x', state || 'x', scope || 'x', resource || 'x', destination || 'x');
			for (const char of ['<', '>', '"']) assert.equal(count(html, char), count(benign, char), `no extra ${char}`);
			const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, key, value]) => [key, unescape(value)]));
			assert.equal(hidden.state, state || 'x');
			assert.equal(hidden.scope, scope || 'x');
			assert.equal(hidden.resource, new URL(`https://mcp.example/${encodeURIComponent(resource || 'x')}`).href);
			assert.ok(html.includes(consentText(destination || 'x').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')));
		}));
	});
});

describe('where sign-in codes may go', () => {
	const allowed = ['claude.ai', 'claude.com', 'chatgpt.com'];
	const other = fc.domain().filter(host => !allowed.includes(host) && !allowed.some(a => host.endsWith(`.${a}`)));

	it('only to an allowlisted https host, this computer over http, or a known desktop app', () => {
		const label = fc.stringMatching(/^[a-z0-9-]{1,12}$/);
		fc.assert(fc.property(other, fc.constantFrom(...allowed), fc.nat({ max: 65535 }), label, (host, good, port, prefix) => {
			for (const uri of [
				// Only the exact host: not a look-alike, not a subdomain, not a host that merely contains it.
				`https://${prefix}${good}/cb`, `https://${prefix}.${good}/cb`,
				`https://${good}.${host}/cb`, `https://${host}/${good}`, `https://${good}@${host}/cb`, `https://${host}/cb?next=${good}`,
				`https://${host}#${good}`, `http://${good}/cb`, `http://${host}:${port}/cb`, `ftp://${good}/cb`, `javascript:alert('${good}')`,
			]) {
				assert.equal(redirectAllowed(uri, allowed), false, uri);
			}
			for (const uri of [`https://${good}/cb`, `https://${good.toUpperCase()}/cb`, `http://127.0.0.1:${port}/cb`, `http://localhost:${port}`, 'cursor://anysphere.cursor-mcp/oauth/callback']) {
				assert.equal(redirectAllowed(uri, allowed), true, uri);
			}
		}));
	});
});

describe('token encryption', () => {
	it('gives back exactly what it encrypted', () => {
		fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 300 }), secret => {
			assert.equal(decrypt(encrypt(secret)), secret);
		}));
	});

	it('refuses anything that was changed', () => {
		fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 50 }), fc.nat(), fc.nat({ max: 14 }), (secret, at, delta) => {
			const sealed = encrypt(secret);
			const index = at % sealed.length;
			fc.pre(sealed[index] !== ':');
			const flipped = ((Number.parseInt(sealed[index], 16) + delta + 1) % 16).toString(16);
			assert.throws(() => decrypt(sealed.slice(0, index) + flipped + sealed.slice(index + 1)));
		}));
	});
});
