/**
 * Quick-start server using `node:http`: works on Node, Bun, and Deno.
 * For fetch-based runtimes, see {@link createFetchHandler}.
 * @module
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { generatePrivateKey } from "viem/accounts";
import type { GetRecord } from "./ens/ensip10.js";
import { CCIPReadError, errorStatus, publicErrorMessage } from "./errors.js";
import { EZCCIP, type EZCCIPOptions } from "./ezccip.js";
import {
	type CCIPReadRequest,
	CORS_HEADERS,
	describeError,
	type HTTPOptions,
	originFromPath,
	PREFLIGHT_HEADERS,
	parseCCIPReadBody,
	parseCCIPReadPath,
} from "./http.js";

/** Largest request body accepted, in bytes. */
const MAX_BODY_SIZE = 1 << 20;

export type ServeOptions = HTTPOptions & {
	/** Port to listen on. (default: random open port) */
	port?: number;
	/** Interface to listen on. (default: all) */
	hostname?: string;
	/** Log startup, every response, every error, and shutdown with `console.log`, prefixed by the date. (default: true) */
	log?: boolean;
	/** Custom values for handlers, copied into `ctx.extra` of every request, along with the client's `ip`. */
	extra?: Record<string, unknown>;
};

export type EZCCIPServer = {
	readonly ezccip: EZCCIP;
	readonly server: Server;
	readonly port: number;
	/** eg. `http://localhost:8016` */
	readonly endpoint: string;
	/**
	 * [TOR context](https://github.com/namestonehq/TheOffchainResolver.sol#context-format):
	 * `"{signer} {endpoint}"`, or just the endpoint without a signer.
	 */
	readonly context: string;
	/** Stops the server and closes open connections. Safe to call more than once. */
	shutdown(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Serve an {@link EZCCIP} instance over HTTP, or an ENSIP-10 `resolve` function:
 * `serveEZCCIP(resolve, options)` is `serveEZCCIP(new EZCCIP(options).enableENSIP10({ resolve }), options)`,
 * signed with a random key unless `signer` is set.
 *
 * Answers `POST {sender, data}` and `GET .../{sender}/{data}.json` with `{data}`, or `{message}` and an HTTP status.
 *
 * @example
 * ```ts
 * import { serveEZCCIP } from "@namestone/ezccip/serve";
 * const ccip = await serveEZCCIP(ezccip, { port: 8016 });
 * // ...
 * await ccip.shutdown();
 *
 * // minimal: fixed text() for any name
 * await using ccip = await serveEZCCIP(() => ({ text: () => "Raffy" }));
 *
 * // handlers see the client's IP as ctx.extra.ip
 * ezccip.addHandler("function ip() returns (string)", (_, ctx) => [String(ctx.extra.ip)]);
 * ```
 */
export function serveEZCCIP(ezccip: EZCCIP, options?: ServeOptions): Promise<EZCCIPServer>;
export function serveEZCCIP(resolve: GetRecord, options?: ServeOptions & EZCCIPOptions): Promise<EZCCIPServer>;
export async function serveEZCCIP(
	arg: EZCCIP | GetRecord,
	options: ServeOptions & EZCCIPOptions = {},
): Promise<EZCCIPServer> {
	const ezccip =
		arg instanceof EZCCIP
			? arg
			: new EZCCIP({ ...options, signer: options.signer ?? generatePrivateKey() }).enableENSIP10({ resolve: arg });
	const {
		port = 0,
		hostname,
		log = true,
		cors = true,
		parseOrigin = (url) => originFromPath(url.pathname),
		extra,
	} = options;
	const print = log ? (...a: unknown[]) => console.log(new Date(), ...a) : undefined;
	const headers = cors ? CORS_HEADERS : {};

	const server = createServer(async (req, res) => {
		if (req.method === "OPTIONS" && cors) {
			res.writeHead(204, PREFLIGHT_HEADERS).end();
			return;
		}
		const url = new URL(req.url ?? "/", "http://localhost");
		const ip = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress;
		try {
			const { sender, data: calldata } = await readRequest(req, url);
			const { data, history } = await ezccip.handleRequest(sender, calldata, {
				origin: parseOrigin(url),
				extra: { ...extra, ip },
			});
			print?.(ip, url.pathname, String(history));
			sendJSON(res, 200, { data }, headers);
		} catch (error) {
			const status = errorStatus(error);
			print?.(ip, req.method, url.pathname, status, describeError(error));
			sendJSON(res, status, { message: publicErrorMessage(error) }, headers);
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, hostname, () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.on("error", (error) => print?.("Server error", error)); // an unhandled "error" would crash the process

	const t0 = Date.now();
	const address = server.address() as AddressInfo;
	const host = !hostname || hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;
	const endpoint = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
	const signer = ezccip.signerAddress;
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
		context,
		shutdown,
		[Symbol.asyncDispose]: shutdown,
	};
}

/** Reads `{sender, data}` from a `node:http` request. */
async function readRequest(req: IncomingMessage, url: URL): Promise<CCIPReadRequest> {
	switch (req.method) {
		case "GET":
			return parseCCIPReadPath(url.pathname);
		case "POST": {
			const tooLarge = new CCIPReadError("request too large", { status: 413 });
			if (Number(req.headers["content-length"]) > MAX_BODY_SIZE) throw tooLarge;
			const chunks: Uint8Array[] = [];
			let size = 0;
			for await (const chunk of req as AsyncIterable<Uint8Array>) {
				size += chunk.length;
				if (size > MAX_BODY_SIZE) throw tooLarge;
				chunks.push(chunk);
			}
			return parseCCIPReadBody(Buffer.concat(chunks).toString("utf8"));
		}
		default:
			throw new CCIPReadError("unsupported http method", { status: 405 });
	}
}

function sendJSON(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>) {
	const buf = Buffer.from(JSON.stringify(body));
	res.writeHead(status, { ...headers, "content-type": "application/json", "content-length": buf.length }).end(buf);
}
