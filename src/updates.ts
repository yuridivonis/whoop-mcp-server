/**
 * Tells the owner when a newer release is out, so updates reach people who deployed once
 * and forgot about it.
 *
 * At most once a day, the server asks GitHub for this project's latest release number.
 * The request carries nothing about the owner or their data: no identifiers, no version,
 * no counts. It only reveals the server's address to GitHub, like any web request.
 * UPDATE_CHECK=false turns it off (see config.ts).
 */

const LATEST_RELEASE_URL = 'https://api.github.com/repos/yuridivonis/whoop-mcp-server/releases/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

interface UpdateCheckerOptions {
	/** The version this server runs. */
	currentVersion: string;
	/** Replaces the global fetch, e.g. in tests. */
	fetch?: typeof fetch;
	now?: () => number;
	/** Where the first sighting of a newer version is logged. */
	log?: (line: string) => void;
}

interface Release {
	version: string;
	url: string;
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
	private latest: Release | null = null;
	private checkedAt = -Infinity;
	private inFlight: Promise<void> | null = null;
	private announced: string | null = null;

	constructor(options: UpdateCheckerOptions) {
		this.currentVersion = options.currentVersion;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (line => process.stderr.write(`${line}\n`));
	}

	/** Asks GitHub for the latest release, unless it was asked in the last day. Never throws. */
	check(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		if (this.now() - this.checkedAt < CHECK_INTERVAL_MS) return Promise.resolve();
		this.checkedAt = this.now();
		this.inFlight = this.fetchLatest().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	/**
	 * A line for the user when a newer release is out, or null. It answers from what the
	 * last check found, and starts a new check in the background once a day.
	 */
	notice(): string | null {
		void this.check();
		const latest = this.latest;
		if (!latest || !isNewer(latest.version, this.currentVersion)) return null;
		return (
			`Update available: version ${latest.version} of this WHOOP MCP server is out (this one runs ${this.currentVersion}). ` +
			`Mention it to the user once; whoever runs the server can update it. Release notes: ${latest.url}`
		);
	}

	private async fetchLatest(): Promise<void> {
		try {
			const response = await this.fetch(LATEST_RELEASE_URL, {
				headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'whoop-mcp-server' },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) return;
			const body = await response.json() as { tag_name?: unknown; html_url?: unknown };
			if (typeof body.tag_name !== 'string' || !parse(body.tag_name)) return;
			const version = body.tag_name.replace(/^v/, '');
			// Only link to this project's own release pages.
			const url = typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/yuridivonis/whoop-mcp-server/')
				? body.html_url
				: 'https://github.com/yuridivonis/whoop-mcp-server/releases';
			this.latest = { version, url };
			if (isNewer(version, this.currentVersion) && this.announced !== version) {
				this.announced = version;
				this.log(`A newer version of whoop-mcp-server is out: ${version} (this server runs ${this.currentVersion}). See ${url}`);
			}
		} catch {
			// Offline, blocked or rate-limited: try again tomorrow. It's only a courtesy.
		}
	}
}
