/**
 * HTTP pieces shared by the adapters ({@link createFetchHandler} and `serveEZCCIP`).
 * @module
 */
import { type Address, getAddress, type Hex } from "viem";
import type { CallContext } from "./context.js";
import { CCIPReadError, publicErrorMessage } from "./errors.js";
import { type EZCCIP, errorContext, type HandleRequestOptions } from "./ezccip.js";

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

/** @internal An HTTP answer: status and JSON body, plus what happened, for logging. */
export type HTTPAnswer = {
	status: number;
	body: { data: Hex } | { message: string };
	context: CallContext | undefined;
	error?: unknown;
};

/** @internal Parses a request, answers it, and turns the result or error into an HTTP answer. */
export async function answer<extra>(
	ezccip: EZCCIP<extra>,
	url: URL,
	parse: () => Promise<CCIPReadRequest>,
	{ parseOrigin = (url) => originFromPath(url.pathname) }: HTTPOptions,
	getExtra: (() => extra) | undefined,
): Promise<HTTPAnswer> {
	try {
		const { sender, data } = await parse();
		const options = { origin: parseOrigin(url), extra: getExtra?.() } as HandleRequestOptions<extra>;
		const { data: response, context } = await ezccip.handleRequest(sender, data, options as never);
		return { status: 200, body: { data: response }, context };
	} catch (error) {
		const status = error instanceof CCIPReadError ? error.status : 500;
		return { status, body: { message: publicErrorMessage(error) }, context: errorContext(error), error };
	}
}

/** @internal Logs an answer: `ip path history` or `ip method path status history error`. */
export function logAnswer(ip: unknown, method: string | undefined, url: URL, { status, context, error }: HTTPAnswer) {
	if (status === 200) {
		console.log(new Date(), ip, url.pathname, String(context?.history));
	} else {
		console.log(
			new Date(),
			ip,
			method,
			url.pathname,
			status,
			...(context ? [String(context.history)] : []),
			// stack trace for unexpected errors
			status >= 500 && !(error instanceof CCIPReadError) ? error : error instanceof Error ? error.message : error,
		);
	}
}
