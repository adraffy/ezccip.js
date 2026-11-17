import { type Address, getAddress, type Hex } from "viem";
import { CCIPReadError } from "./errors.js";
import type { EZCCIP, HandleReadParameters, HandleReadReturnType } from "./ezccip.js";
import type { ExtraParameter } from "./types.js";

/** Passed to {@link RequestHooks.onResponse} after a successful response. */
export type RequestSuccessEvent<extra = undefined> = HandleReadReturnType<extra> & {
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
};

/** Observers for HTTP requests, eg. for logging or metrics. Exceptions thrown by hooks are ignored. */
export type RequestHooks<extra = undefined> = {
	onResponse?: ((event: RequestSuccessEvent<extra>) => void) | undefined;
	onError?: ((event: RequestErrorEvent) => void) | undefined;
};

export type HandleRequestOptions<extra = undefined> = RequestHooks<extra> & ExtraParameter<extra>;

/** An [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) request parsed from HTTP. */
export type CCIPReadRequest = {
	sender: Hex;
	data: Hex;
	/** URL path, without the `/{sender}/{data}.json` suffix of a `GET`. */
	path: string;
};

const CORS_HEADERS = { "access-control-allow-origin": "*" };

/**
 * Parses an EIP-3668 request:
 * - `POST {sender, data}`
 * - `GET .../{sender}/{data}.json`
 */
export async function parseCCIPReadRequest(request: Request, url = new URL(request.url)): Promise<CCIPReadRequest> {
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
			return { sender, data, path: url.pathname };
		}
		case "GET": {
			const match = url.pathname.match(/\/(0x[0-9a-f]{40})\/(0x[0-9a-f]*)(?:\.json)?$/i);
			if (!match) throw new CCIPReadError("expected /{sender}/{data}", { status: 400 });
			return {
				sender: match[1] as Hex,
				data: match[2] as Hex,
				path: url.pathname.slice(0, match.index),
			};
		}
		default:
			throw new CCIPReadError("unsupported http method", { status: 405 });
	}
}

/** Returns the first `/0x{40}` component of a path, eg. `/a/0xABCD.../b`. */
export function originFromPath(path: string): Address | undefined {
	const match = path.match(/\/(0x[0-9a-f]{40})(?=\/|$)/i);
	return match ? getAddress(match[1]!) : undefined;
}

/**
 * Handles an HTTP request with an {@link EZCCIP} instance.
 * Responds with `{data}`, or `{message}` and an HTTP status on error. CORS is enabled.
 * The origin is taken from the path, then `parseOrigin()`, then the `origin` option.
 */
export async function handleRequest<extra>(
	ezccip: EZCCIP<extra>,
	request: Request,
	options?: HandleRequestOptions<extra>,
): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, {
			status: 204,
			headers: {
				...CORS_HEADERS,
				"access-control-allow-methods": "GET, POST, OPTIONS",
				"access-control-allow-headers": "*",
			},
		});
	}
	const url = new URL(request.url);
	const hooks = [ezccip.options, options];
	let event: RequestSuccessEvent<extra>;
	try {
		const { sender, data, path } = await parseCCIPReadRequest(request, url);
		const origin = originFromPath(path) ?? ezccip.options.parseOrigin?.(url) ?? ezccip.options.origin;
		const parameters = { sender, data, origin, request, extra: options?.extra } as HandleReadParameters<extra>;
		event = { ...(await ezccip.handleRead(parameters)), request, url };
	} catch (error) {
		const status = error instanceof CCIPReadError ? error.status : 500;
		for (const x of hooks) callHook(x?.onError, { request, url, error, status });
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ message }, { status, headers: CORS_HEADERS });
	}
	for (const x of hooks) callHook(x?.onResponse, event);
	return Response.json({ data: event.data }, { headers: CORS_HEADERS });
}

function callHook<T>(hook: ((event: T) => void) | undefined, event: T) {
	try {
		hook?.(event);
	} catch {
		// hooks are observers
	}
}
