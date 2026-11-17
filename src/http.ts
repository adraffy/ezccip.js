import { type Address, getAddress, type Hex } from "viem";
import type { CallContext } from "./context.js";
import { CCIPReadError } from "./errors.js";
import type { HandleReadReturnType } from "./ezccip.js";
import type { ExtraParameter } from "./types.js";

/** Passed to {@link RequestHooks.onResponse} after a successful response. */
export type RequestSuccessEvent = HandleReadReturnType & {
	request: Request;
	url: URL;
};

/** Passed to {@link RequestHooks.onError} after a failed response. */
export type RequestErrorEvent = {
	request: Request;
	url: URL;
	error: unknown;
	/** HTTP status of the response. */
	status: number;
	/** Context of the outer call, if the request got that far. Its `history` shows which call failed. */
	context: CallContext | undefined;
};

/**
 * Observers for HTTP requests, eg. for logging or metrics.
 * Exceptions thrown by hooks and rejections of async hooks are ignored.
 */
export type RequestHooks = {
	onResponse?: ((event: RequestSuccessEvent) => unknown) | undefined;
	onError?: ((event: RequestErrorEvent) => unknown) | undefined;
};

export type HandleRequestOptions<extra = undefined> = RequestHooks &
	ExtraParameter<extra> & {
		/** Add CORS headers and answer `OPTIONS` preflight requests. (default: true) */
		cors?: boolean | undefined;
	};

/** An [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) request parsed from HTTP. */
export type CCIPReadRequest = { sender: Hex; data: Hex };

export const CORS_HEADERS = { "access-control-allow-origin": "*" };

/**
 * Parses an EIP-3668 request:
 * - `POST {sender, data}`
 * - `GET .../{sender}/{data}.json`
 */
export async function parseCCIPReadRequest(request: Request): Promise<CCIPReadRequest> {
	switch (request.method) {
		case "POST": {
			let json: unknown;
			try {
				json = await request.json();
			} catch (cause) {
				throw new CCIPReadError("expected JSON", { status: 400, cause });
			}
			const { sender, data } = (json ?? {}) as Partial<CCIPReadRequest>;
			if (typeof sender !== "string" || typeof data !== "string") {
				throw new CCIPReadError("expected {sender, data}", { status: 400 });
			}
			return { sender, data };
		}
		case "GET": {
			const match = new URL(request.url).pathname.match(/\/(0x[0-9a-f]{40})\/(0x[0-9a-f]*)(?:\.json)?$/i);
			if (!match) throw new CCIPReadError("expected /{sender}/{data}", { status: 400 });
			return { sender: match[1] as Hex, data: match[2] as Hex };
		}
		default:
			throw new CCIPReadError("unsupported http method", { status: 405 });
	}
}

/** Returns the first `/0x{40}` component of a path, eg. `/a/0xABCD.../b`. The default `parseOrigin`. */
export function originFromPath(path: string): Address | undefined {
	const match = path.match(/\/(0x[0-9a-f]{40})(?=\/|$)/i);
	return match ? getAddress(match[1]!) : undefined;
}

/** Calls an observer without waiting for it, ignoring exceptions and rejections. Never rejects. */
export async function callHook<T>(hook: ((event: T) => unknown) | undefined, event: T): Promise<void> {
	try {
		await hook?.(event);
	} catch {
		// observers can't break a response
	}
}
