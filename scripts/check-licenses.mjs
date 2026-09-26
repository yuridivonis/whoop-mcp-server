/**
 * Fails if a production dependency's licence isn't on the permissive list. This project is
 * MIT-licensed, and a new dependency shouldn't quietly restrict how it can be used.
 *
 * Usage: node scripts/check-licenses.mjs (after npm ci)
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense']);

/** An SPDX expression is allowed if one of its OR alternatives uses only allowed licences. */
export function licenseAllowed(expression) {
	if (typeof expression !== 'string' || !expression.trim()) return false;
	return expression
		.replace(/[()]/g, '')
		.split(/\s+OR\s+/i)
		.some(alternative => alternative.split(/\s+AND\s+/i).every(id => ALLOWED.has(id.trim())));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
