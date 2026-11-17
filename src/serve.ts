/**
 * Quick-start server using `node:http`: works on Node, Bun, and Deno.
 * To use your own server, pass {@link EZCCIP.fetch} to it instead.
 * @module
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Address } from "viem";
import type { GetRecord } from "./ens/ensip10.js";
import { CCIPReadError } from "./errors.js";
import { EZCCIP, type EZCCIPOptions } from "./ezccip.js";

export type ServeOptions = {
	/** Port to listen on. (default: random open port) */
	port?: number;
	/** Interface to listen on. (default: all) */
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
	readonly server: Server;
	readonly port: number;
	/** eg. `http://localhost:8016` */
	readonly endpoint: string;
	/** Address of the default signer. */
	readonly signer: Address | undefined;
	/** [TOR context](https://github.com/namestonehq/TheOffchainResolver.sol#context-format): `"{signer} {endpoint}"` */
	readonly context: string;
	/** Stops the server and closes open connections. Safe to call more than once. */
	shutdown(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Serve an {@link EZCCIP} instance (or an ENSIP-10 record function) over HTTP.
 *
 * @example
 * ```ts
 * import { serveEZCCIP } from "@namestone/ezccip/serve";
 * const ccip = await serveEZCCIP(ezccip, { port: 8016 });
 * // ...
 * await ccip.shutdown();
 *
 * // minimal: fixed text() for any name
 * await using ccip = await serveEZCCIP(() => ({ text: () => "Raffy" }), { signer: privateKey });
 * ```
 */
export function serveEZCCIP(ezccip: EZCCIP, options?: ServeOptions): Promise<EZCCIPServer>;
export function serveEZCCIP(getRecord: GetRecord, options?: ServeOptions & EZCCIPOptions): Promise<EZCCIPServer>;
export async function serveEZCCIP(
	ezccip: EZCCIP | GetRecord,
	{ port = 0, hostname, log = true, ...options }: ServeOptions & EZCCIPOptions = {},
): Promise<EZCCIPServer> {
	if (typeof ezccip === "function") {
		const getRecord = ezccip;
		ezccip = new EZCCIP(options);
		ezccip.enableENSIP10(getRecord);
	}
	const print = log === true ? (...a: unknown[]) => console.log(new Date(), ...a) : log || undefined;

	const server = createServer(async (req, res) => {
		const ip = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress;
		try {
			const request = await toRequest(req);
			const response = await ezccip.handleRequest(request, {
				onResponse: ({ url, context }) => print?.(ip, url.pathname, context.history.toString()),
				onError: ({ url, error, status }) =>
					print?.(
						ip,
						request.method,
						url.pathname,
						status,
						// stack trace for unexpected errors
						status >= 500 && !(error instanceof CCIPReadError) ? error : error instanceof Error ? error.message : error,
					),
			});
			await sendResponse(res, response);
		} catch (error) {
			// aborted or malformed request
			print?.(ip, req.method, req.url, error);
			if (!res.headersSent) res.statusCode = 400;
			res.end();
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, hostname, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const t0 = Date.now();
	const address = server.address() as AddressInfo;
	const host = !hostname || hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;
	const endpoint = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
	const { signer } = ezccip;
	const context = signer ? `${signer} ${endpoint}` : endpoint;
	print?.(`Serving "${ezccip.protocol}" ${context}`);

	let stopping: Promise<void> | undefined;
	const shutdown = () => {
		stopping ??= new Promise<void>((resolve) => {
			server.close(() => {
				print?.(`Shutdown<${Date.now() - t0}ms>`);
				resolve();
			});
			server.closeAllConnections(); // keep-alive connections would hold close() open
		});
		return stopping;
	};
	return {
		ezccip,
		server,
		port: address.port,
		endpoint,
		signer,
		context,
		shutdown,
		[Symbol.asyncDispose]: shutdown,
	};
}

/** Converts a `node:http` request into a fetch `Request`. */
async function toRequest(req: IncomingMessage): Promise<Request> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (Array.isArray(value)) {
			for (const x of value) headers.append(key, x);
		} else if (value !== undefined) {
			headers.set(key, value);
		}
	}
	let body: Uint8Array<ArrayBuffer> | undefined;
	if (req.method !== "GET" && req.method !== "HEAD") {
		const chunks: Uint8Array[] = [];
		for await (const chunk of req) chunks.push(chunk);
		body = new Uint8Array(Buffer.concat(chunks));
	}
	return new Request(url, { method: req.method, headers, body });
}

/** Writes a fetch `Response` to a `node:http` response. */
async function sendResponse(res: ServerResponse, response: Response) {
	res.statusCode = response.status;
	response.headers.forEach((value, key) => {
		res.setHeader(key, value);
	});
	res.end(Buffer.from(await response.arrayBuffer()));
}
