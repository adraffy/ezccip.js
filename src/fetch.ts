import type { EZCCIP } from "./ezccip.js";
import { answer, CORS_HEADERS, type HTTPOptions, logAnswer, PREFLIGHT_HEADERS, parseCCIPReadRequest } from "./http.js";

export type FetchHandlerOptions<extra = undefined, args extends unknown[] = []> = HTTPOptions &
	(undefined extends extra
		? { extra?: ((request: Request, ...args: args) => extra) | undefined }
		: { extra: (request: Request, ...args: args) => extra });

/**
 * Creates a `fetch(request) => response` handler for Bun, Deno, Cloudflare Workers, Hono, etc.
 * Answers `POST {sender, data}` and `GET .../{sender}/{data}.json` with `{data}`,
 * or `{message}` and an HTTP status.
 *
 * @example
 * ```ts
 * export default { fetch: createFetchHandler(ezccip) };
 *
 * // Cloudflare Workers: pass env to handlers
 * const ezccip = new EZCCIP<{ env: Env }>();
 * export default { fetch: createFetchHandler(ezccip, { extra: (request, env: Env) => ({ env }) }) };
 * ```
 */
export function createFetchHandler<extra = undefined, args extends unknown[] = []>(
	ezccip: EZCCIP<extra>,
	...[options]: undefined extends extra
		? [options?: FetchHandlerOptions<extra, args>]
		: [options: FetchHandlerOptions<extra, args>]
): (request: Request, ...args: args) => Promise<Response> {
	const { cors = true, log = false } = options ?? {};
	const headers = cors ? CORS_HEADERS : undefined;
	return async (request, ...args) => {
		if (request.method === "OPTIONS" && cors) {
			return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
		}
		const url = new URL(request.url);
		const getExtra = options?.extra && (() => options.extra!(request, ...args) as extra);
		const result = await answer(ezccip, url, () => parseCCIPReadRequest(request), options ?? {}, getExtra);
		if (log) logAnswer(request.headers.get("x-forwarded-for"), request.method, url, result);
		return Response.json(result.body, { status: result.status, headers });
	};
}
