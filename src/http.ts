/**
 * HTTP pieces shared by the adapters ({@link createFetchHandler} and `serveEZCCIP`).
 * @module
 */
import { type Address, getAddress, type Hex } from "viem";
import { CCIPReadError } from "./errors.js";

/** An [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) request. */
export type CCIPReadRequest = { sender: Hex; data: Hex };

/** Options shared by the HTTP adapters. */
export type HTTPOptions = {
	/** Add CORS headers and answer `OPTIONS` preflight requests. (default: true) */
	cors?: boolean | undefined;
	/**
	 * Finds the origin (the contract that verifies the response) in the request URL.
	 * If it returns nothing, the origin is the `sender`. (default: {@link originFromPath})
	 */
	parseOrigin?: ((url: URL) => Address | undefined) | undefined;
	/** Log every response and error with `console.log`, prefixed by the date. */
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

/** Returns the first `/0x{40}` component of a path, eg. `/a/0xABCD.../b`. The default `parseOrigin`. */
export function originFromPath(path: string): Address | undefined {
	const match = path.match(/\/(0x[0-9a-f]{40})(?=\/|$)/i);
	return match ? getAddress(match[1]!) : undefined;
}

/** @internal What to log for an error: the stack trace if unexpected, otherwise the message. */
export function describeError(error: unknown): unknown {
	return error instanceof CCIPReadError ? error.message : error;
}
