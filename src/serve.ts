/**
 * Quick-start server for Bun.
 * For other runtimes, use {@link EZCCIP.fetch} directly.
 * @module
 */
import type { Address } from "viem";
import type { GetRecord } from "./ens/ensip10.js";
import { CCIPReadError } from "./errors.js";
import { EZCCIP, type EZCCIPOptions } from "./ezccip.js";

export type ServeOptions = {
	/** Port to listen on. (default: random open port) */
	port?: number;
	hostname?: string;
	/**
	 * Logs startup, every response, every error, and shutdown.
	 * `true` uses `console.log` with a date, a function receives the same arguments, `false` disables.
	 * (default: true)
	 */
	log?: boolean | ((...args: unknown[]) => void);
};

export type EZCCIPServer = {
	readonly ezccip: EZCCIP;
	readonly server: ReturnType<typeof Bun.serve>;
	readonly port: number;
	/** eg. `http://localhost:8016` */
	readonly endpoint: string;
	/** Address of the default signer. */
	readonly signer: Address | undefined;
	/** [TOR context](https://github.com/namestonehq/TheOffchainResolver.sol#context-format): `"{signer} {endpoint}"` */
	readonly context: string;
	/** Stops the server. Safe to call more than once. */
	shutdown(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Serve an {@link EZCCIP} instance (or an ENSIP-10 record function) using `Bun.serve()`.
 *
 * @example
 * ```ts
 * import { serveEZCCIP } from "@namestone/ezccip/serve";
 * const ccip = serveEZCCIP(ezccip, { port: 8016 });
 * // ...
 * await ccip.shutdown();
 *
 * // minimal: fixed text() for any name
 * await using ccip = serveEZCCIP(() => ({ text: () => "Raffy" }), { signer: privateKey });
 * ```
 */
export function serveEZCCIP(ezccip: EZCCIP, options?: ServeOptions): EZCCIPServer;
export function serveEZCCIP(getRecord: GetRecord, options?: ServeOptions & EZCCIPOptions): EZCCIPServer;
export function serveEZCCIP(
	ezccip: EZCCIP | GetRecord,
	{ port = 0, hostname, log = true, ...options }: ServeOptions & EZCCIPOptions = {},
): EZCCIPServer {
	if (typeof ezccip === "function") {
		const getRecord = ezccip;
		ezccip = new EZCCIP(options);
		ezccip.enableENSIP10(getRecord);
	}
	const ccip = ezccip;
	const print = log === true ? (...a: unknown[]) => console.log(new Date(), ...a) : log || undefined;
	const server = Bun.serve({
		port,
		hostname,
		fetch(request, server) {
			if (!print) return ccip.fetch(request);
			const ip = request.headers.get("x-forwarded-for") ?? server.requestIP(request)?.address;
			return ccip.handleRequest(request, {
				onResponse: ({ url, history }) => print(ip, url.pathname, history.toString()),
				onError: ({ url, error, status }) =>
					print(
						ip,
						request.method,
						url.pathname,
						status,
						// stack trace for unexpected errors
						status >= 500 && !(error instanceof CCIPReadError) ? error : error instanceof Error ? error.message : error,
					),
			});
		},
	});
	const t0 = Date.now();
	const endpoint = server.url.origin;
	const { signer } = ccip;
	const context = signer ? `${signer} ${endpoint}` : endpoint;
	print?.(`Serving "${ccip.protocol}" ${context}`);
	let stopping: Promise<void> | undefined;
	const shutdown = () =>
		(stopping ??= server.stop(true).then(() => {
			print?.(`Shutdown<${Date.now() - t0}ms>`);
		}));
	return {
		ezccip: ccip,
		server,
		port: server.port!,
		endpoint,
		signer,
		context,
		shutdown,
		[Symbol.asyncDispose]: shutdown,
	};
}
