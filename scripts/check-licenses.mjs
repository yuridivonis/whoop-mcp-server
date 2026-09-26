/**
 * Fails if a production dependency's licence isn't on the permissive list. This project is
 * MIT-licensed, and a new dependency shouldn't quietly restrict how it can be used.
 *
 * Usage: node scripts/check-licenses.mjs (after npm ci)
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense']);

/**
 * Whether an SPDX licence expression is allowed. OR needs one allowed side and AND needs
 * both; brackets group as usual. Anything else (WITH exceptions, unknown licences,
 * malformed expressions) is refused.
 */
export function licenseAllowed(expression) {
	if (typeof expression !== 'string') return false;
	const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
	let i = 0;
	const next = () => tokens[i]?.toUpperCase();

	// or := and ('OR' and)*    and := atom ('AND' atom)*    atom := '(' or ')' | licence
	function or() {
		let allowed = and();
		while (next() === 'OR') {
			i++;
			const right = and();
			allowed = allowed || right;
		}
		return allowed;
	}
	function and() {
		let allowed = atom();
		while (next() === 'AND') {
			i++;
			const right = atom();
			allowed = allowed && right;
		}
		return allowed;
	}
	function atom() {
		const token = tokens[i++];
		if (token === '(') {
			const allowed = or();
			if (tokens[i++] !== ')') throw new SyntaxError('unclosed bracket');
			return allowed;
		}
		if (token === undefined || token === ')' || ['AND', 'OR', 'WITH'].includes(token.toUpperCase())) {
			throw new SyntaxError(`unexpected ${token ?? 'end'}`);
		}
		return ALLOWED.has(token);
	}

	try {
		const allowed = or();
		return allowed && i === tokens.length;
	} catch {
		return false;
	}
}

// Run directly (not imported by the tests). realpath, so a symlinked checkout still runs it.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const packages = JSON.parse(execFileSync('npm', ['query', '.prod'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
	const refused = packages
		.map(pkg => ({ id: `${pkg.name}@${pkg.version}`, license: typeof pkg.license === 'object' ? pkg.license?.type : pkg.license }))
		.filter(pkg => !licenseAllowed(pkg.license));
	if (refused.length > 0) {
		console.error('Production dependencies with a licence outside the permissive list:');
		for (const pkg of refused) console.error(`  ${pkg.id}: ${pkg.license ?? 'none declared'}`);
		process.exit(1);
	}
	console.log(`${packages.length} production dependencies, all permissively licensed.`);
}
