/**
 * HTTP pieces shared by the adapters ({@link createFetchHandler} and `serveEZCCIP`).
 * @module
 */
import type { Address, Hex } from "viem";
import type { ReadContext } from "./context.js";
import { CCIPReadError } from "./errors.js";

/** An [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) request. */
export type CCIPReadRequest = { sender: Hex; data: Hex };

/** Options shared by the HTTP adapters. */
export type HTTPOptions = {
	/** Add CORS headers and answer `OPTIONS` preflight requests. (default: true) */
	cors?: boolean | undefined;
	/**
	 * Finds the contract that issued the request, and its chain, in the request URL.
	 * Without an origin, the origin is the `sender`. (default: {@link originFromQuery})
	 */
	parseOrigin?: ((url: URL) => RequestOrigin) | undefined;
	/** Log every response and error with `console.log`, prefixed by the date. (default: `serveEZCCIP` true, `createFetchHandler` false) */
	log?: boolean | undefined;
};

export const CORS_HEADERS = { "access-control-allow-origin": "*" } as const;
export const PREFLIGHT_HEADERS = {
	...CORS_HEADERS,
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "*",
} as const;

/** Parses a `GET .../{sender}/{data}.json` path. */
export function parseCCIPReadPath(path: string): CCIPReadRequest {
	const match = path.match(/\/(0x[0-9a-f]{40})\/(0x[0-9a-f]*)(?:\.json)?$/i);
	if (!match) throw new CCIPReadError("expected /{sender}/{data}", { status: 400 });
	return { sender: match[1] as Hex, data: match[2] as Hex };
}

/** Parses a `POST` body: JSON `{sender, data}`. */
export function parseCCIPReadBody(body: string): CCIPReadRequest {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch (cause) {
		throw new CCIPReadError("expected JSON", { status: 400, cause });
	}
	const { sender, data } = (json ?? {}) as Partial<CCIPReadRequest>;
	if (typeof sender !== "string" || typeof data !== "string") {
		throw new CCIPReadError("expected {sender, data}", { status: 400 });
	}
	return { sender, data };
}

/** Parses an EIP-3668 request from a fetch `Request`: `POST {sender, data}` or `GET .../{sender}/{data}.json`. */
export async function parseCCIPReadRequest(request: Request): Promise<CCIPReadRequest> {
	switch (request.method) {
		case "POST":
			return parseCCIPReadBody(await request.text());
		case "GET":
			return parseCCIPReadPath(new URL(request.url).pathname);
		default:
			throw new CCIPReadError("unsupported http method", { status: 405 });
	}
}

/** The contract that issued a request, and its chain, if known. */
export type RequestOrigin = {
	/** Contract that will verify the response. */
	origin?: Address | undefined;
	/** Chain of that contract. */
	chainId?: number | undefined;
};

/**
 * Reads `?origin=0x...&chainId=1` from a URL. Both are optional. The default `parseOrigin`.
 *
 * `OffchainLookup` only identifies the `sender`, which may not be the contract that issued
 * the request (it can be wrapped and rethrown), so put the origin and its chain in the gateway URL.
 */
export function originFromQuery(url: URL): RequestOrigin {
	const origin = url.searchParams.get("origin") ?? undefined;
	const chain = url.searchParams.get("chainId") ?? undefined;
	if (chain !== undefined && !/^\d+$/.test(chain)) throw new CCIPReadError("invalid chainId", { status: 400 });
	return { origin: origin as Address | undefined, chainId: chain === undefined ? undefined : Number(chain) };
}

/** @internal Where a request came from, for logging: `{chainId}:{origin}`, with `?` for an unknown chain. */
export function formatOrigin({ chainId, origin }: ReadContext): string {
	return `${chainId ?? "?"}:${origin}`;
}

/** @internal What to log for an error: the stack trace if unexpected, otherwise the message. */
export function describeError(error: unknown): unknown {
	return error instanceof CCIPReadError ? error.message : error;
}
