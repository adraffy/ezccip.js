import { errorStatus, publicErrorMessage } from "./errors.js";
import type { EZCCIP } from "./ezccip.js";
import {
	CORS_HEADERS,
	describeError,
	type HTTPOptions,
	originFromPath,
	PREFLIGHT_HEADERS,
	parseCCIPReadRequest,
} from "./http.js";

/**
 * Creates a `fetch(request, extra?) => response` handler for Bun, Deno, Cloudflare Workers, Hono, etc.
 * Answers `POST {sender, data}` and `GET .../{sender}/{data}.json` with `{data}`,
 * or `{message}` and an HTTP status.
 *
 * The fields of `extra` are copied into `ctx.extra`: pass your own, or let the runtime pass its
 * second argument, eg. Cloudflare's `env`.
 *
 * @example
 * ```ts
 * export default { fetch: createFetchHandler(ezccip) }; // Cloudflare: ctx.extra is env
 *
 * const handler = createFetchHandler(ezccip);
 * Bun.serve({ fetch: (request, server) => handler(request, { ip: server.requestIP(request)?.address }) });
 * ```
 */
export function createFetchHandler(
	ezccip: EZCCIP,
	{ cors = true, log = false, parseOrigin = (url) => originFromPath(url.pathname) }: HTTPOptions = {},
): (request: Request, extra?: object) => Promise<Response> {
	const headers = cors ? CORS_HEADERS : undefined;
	return async (request, extra) => {
		if (request.method === "OPTIONS" && cors) {
			return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
		}
		const url = new URL(request.url);
		const ip = request.headers.get("x-forwarded-for");
		try {
			const { sender, data: calldata } = await parseCCIPReadRequest(request);
			const { data, history } = await ezccip.handleRequest(sender, calldata, {
				origin: parseOrigin(url),
				extra: { ...extra },
			});
			if (log) console.log(new Date(), ip, url.pathname, String(history));
			return Response.json({ data }, { headers });
		} catch (error) {
			const status = errorStatus(error);
			if (log) console.log(new Date(), ip, request.method, url.pathname, status, describeError(error));
			return Response.json({ message: publicErrorMessage(error) }, { status, headers });
		}
	};
}
