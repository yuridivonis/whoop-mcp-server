/**
 * Tells the owner when a newer release is out, so updates reach people who deployed once
 * and forgot about it.
 *
 * Once a day, on a timer that starts with the server, it asks GitHub for this project's
 * latest release number. The request carries nothing about the owner or their data: no
 * identifiers, no version, no counts, and its timing doesn't follow their use of the tools.
 * It only reveals the server's address to GitHub, like any web request.
 * UPDATE_CHECK=false turns it off (see config.ts).
 */

const LATEST_RELEASE_URL = 'https://api.github.com/repos/yuridivonis/whoop-mcp-server/releases/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
// A release answer is a few kilobytes; anything far bigger isn't one.
const MAX_RESPONSE_CHARS = 1_000_000;
const RELEASES_URL = 'https://github.com/yuridivonis/whoop-mcp-server/releases';
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

interface UpdateCheckerOptions {
	/** The version this server runs. */
	currentVersion: string;
	/** Replaces the global fetch, e.g. in tests. */
	fetch?: typeof fetch;
	now?: () => number;
	/** Where the first sighting of a newer version is logged. */
	log?: (line: string) => void;
	/** Runs fn after ms without keeping the process alive; replaceable in tests. */
	schedule?: (fn: () => void, ms: number) => void;
}

function parse(version: string): number[] | null {
	const match = VERSION.exec(version.trim());
	return match ? match.slice(1).map(Number) : null;
}

/** Whether `candidate` is a later version than `current`; false if either can't be read. */
export function isNewer(candidate: string, current: string): boolean {
	const a = parse(candidate);
	const b = parse(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] > b[i];
	}
	return false;
}

export class UpdateChecker {
	private readonly currentVersion: string;
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly schedule: (fn: () => void, ms: number) => void;
	private latest: string | null = null;
	private checkedAt = -Infinity;
	private inFlight: Promise<void> | null = null;
	private announced: string | null = null;

	constructor(options: UpdateCheckerOptions) {
		this.currentVersion = options.currentVersion;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (line => process.stderr.write(`${line}\n`));
		this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref());
	}

	/** Checks now, then a day after each check, until the process exits. */
	start(): void {
		void this.check(true).finally(() => this.schedule(() => this.start(), CHECK_INTERVAL_MS));
	}

	/**
	 * Asks GitHub for the latest release, unless it was asked in the last day. The daily
	 * timer passes `due`, since its day has passed even if the clock was set back. Never throws.
	 */
	check(due = false): Promise<void> {
		if (this.inFlight) return this.inFlight;
		if (!due && this.now() - this.checkedAt < CHECK_INTERVAL_MS) return Promise.resolve();
		this.checkedAt = this.now();
		this.inFlight = this.fetchLatest().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	/** A line for the user when the last check found a newer release, or null. Never contacts GitHub. */
	notice(): string | null {
		const latest = this.latest;
		if (!latest || !isNewer(latest, this.currentVersion)) return null;
		return (
			`Update available: version ${latest} of this WHOOP MCP server is out (this one runs ${this.currentVersion}). ` +
			`Mention it to the user once; whoever runs the server can update it. Release notes: ${RELEASES_URL}/tag/v${latest}`
		);
	}

	private async fetchLatest(): Promise<void> {
		try {
			const response = await this.fetch(LATEST_RELEASE_URL, {
				headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'whoop-mcp-server' },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) return;
			if (Number(response.headers.get('content-length')) > MAX_RESPONSE_CHARS) return;
			const text = await response.text();
			if (text.length > MAX_RESPONSE_CHARS) return;
			const body = JSON.parse(text) as { tag_name?: unknown };
			// Only the version number is used, rebuilt from its digits, so nothing else in the
			// answer can reach the log or the model.
			const numbers = typeof body.tag_name === 'string' ? parse(body.tag_name) : null;
			if (!numbers) return;
			const version = numbers.join('.');
			this.latest = version;
			if (isNewer(version, this.currentVersion) && this.announced !== version) {
				this.announced = version;
				this.log(`A newer version of whoop-mcp-server is out: ${version} (this server runs ${this.currentVersion}). See ${RELEASES_URL}/tag/v${version}`);
			}
		} catch {
			// Offline, blocked or rate-limited: try again tomorrow. It's only a courtesy.
		}
	}
}
