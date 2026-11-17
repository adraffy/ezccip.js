import {
	type AbiFunction,
	type Address,
	decodeAbiParameters,
	encodeAbiParameters,
	getAddress,
	type Hex,
	isAddress,
	isHex,
	type ParseAbiItem,
	parseAbiItem,
	toFunctionSelector,
	toFunctionSignature,
} from "viem";
import { CallContext, defaultProtocol, type ReadState } from "./context.js";
import { MULTICALL, RESOLVE } from "./ens/abi.js";
import { createENSIP10Handler, type ENSIP10Parameters } from "./ens/ensip10.js";
import { CCIPReadError, encodeErrorString, publicErrorMessage } from "./errors.js";
import { History } from "./history.js";
import {
	CORS_HEADERS,
	callHook,
	type HandleRequestOptions,
	originFromPath,
	parseCCIPReadRequest,
	type RequestHooks,
} from "./http.js";
import { type Protocol, type Signer, type SignerLike, signResponse, toSigner } from "./signing.js";
import type { BytesLike, ExtraParameter, Handler, HandlerFunction } from "./types.js";
import { bytesLikeToHex, getSelector, stripSelector } from "./utils.js";

export type EZCCIPOptions = RequestHooks & {
	/** Default signer: a private key or eg. a viem `LocalAccount`. */
	signer?: SignerLike | undefined;
	/** Default protocol. (default: `"ens"` with a signer, otherwise `"raw"`) */
	protocol?: Protocol | undefined;
	/** Default response lifetime in seconds. (default: 60) */
	ttl?: number | undefined;
	/** Default origin. (default: `sender`) */
	origin?: Address | undefined;
	/**
	 * Extracts the origin from the URL of an HTTP request.
	 * (default: the first `/0x{40}` path component, see {@link originFromPath})
	 */
	parseOrigin?: ((url: URL) => Address | undefined) | undefined;
};

export type HandleReadParameters<extra = undefined> = ExtraParameter<extra> & {
	sender: Hex;
	/** Calldata from `OffchainLookup`. */
	data: Hex;
	/** Contract that will verify the response. (default: `origin` option, then `sender`) */
	origin?: Address | undefined;
	protocol?: Protocol | undefined;
	signer?: SignerLike | undefined;
	ttl?: number | undefined;
	/** The HTTP request, if any. */
	request?: Request | undefined;
};

export type HandleReadReturnType = {
	/** ABI-encoded response for EIP-3668. */
	data: Hex;
	/** Context of the outer call. Its `history` describes the whole response. */
	context: CallContext;
};

/** `(request) => response`, only when `extra` is optional. Otherwise use {@link EZCCIP.handleRequest}. */
export type FetchHandler<extra> = undefined extends extra ? (request: Request) => Promise<Response> : never;

/** Human-readable function signature, with or without the `function` prefix. */
type ParseFunction<signature extends string> = Extract<
	ParseAbiItem<signature extends `function ${string}` ? signature : `function ${signature}`>,
	AbiFunction
>;

const MULTICALL_SELECTOR = toFunctionSelector(MULTICALL);

/**
 * Turnkey [EIP-3668: CCIP-Read](https://eips.ethereum.org/EIPS/eip-3668) handler.
 *
 * `multicall(bytes[])` is built in: it is only answered as the outer call, and its subcalls cannot be `multicall()`.
 *
 * @example
 * ```ts
 * const ezccip = new EZCCIP({ signer: privateKey });
 * ezccip.addHandler("function plus(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a + b]);
 * export default { fetch: ezccip.fetch };
 * ```
 *
 * @typeParam extra - Custom object passed with each request, given to handlers as their third argument.
 */
export class EZCCIP<extra = undefined> {
	readonly #signer: Signer | undefined;
	readonly #protocol: Protocol | undefined;
	readonly #ttl: number;
	readonly #origin: Address | undefined;
	readonly #parseOrigin: (url: URL) => Address | undefined;
	readonly #hooks: RequestHooks;
	readonly #handlers = new Map<Hex, Handler<any, extra>>();

	constructor({ signer, protocol, ttl = 60, origin, parseOrigin, onResponse, onError }: EZCCIPOptions = {}) {
		if (origin !== undefined && !isAddress(origin, { strict: false })) throw new TypeError(`invalid origin: ${origin}`);
		this.#signer = signer ? toSigner(signer) : undefined;
		this.#protocol = protocol;
		this.#ttl = ttl;
		this.#origin = origin && getAddress(origin);
		this.#parseOrigin = parseOrigin ?? ((url) => originFromPath(url.pathname));
		this.#hooks = { onResponse, onError };
		this.addHandler(MULTICALL, async ([calls], ctx, extra) => {
			ctx.history.show = false;
			const results = calls.map((call) =>
				this.#call(ctx.nested(call, ctx.history.addChild()), extra, true).catch(encodeErrorString),
			);
			return [await Promise.all(results)];
		});
	}

	/** Address of the default signer. */
	get signerAddress(): Address | undefined {
		return this.#signer?.address;
	}

	/** Default protocol. */
	get protocol(): Protocol {
		return this.#protocol ?? defaultProtocol(this.#signer);
	}

	/** All handlers, including the built-in `multicall`. */
	get handlers(): Handler<AbiFunction, extra>[] {
		return [...this.#handlers.values()];
	}

	/**
	 * Adds a handler for an offchain function. Arguments and outputs are typed from the function.
	 * Adding the same selector again replaces it.
	 *
	 * @example
	 * ```ts
	 * ezccip.addHandler("function plus(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a + b]);
	 * ezccip.addHandler(getAbiItem({ abi, name: "f" }), ([x], ctx) => [x]);
	 * ```
	 */
	addHandler<const signature extends string>(
		signature: signature,
		fn: HandlerFunction<ParseFunction<signature>, extra>,
	): Handler<ParseFunction<signature>, extra>;
	addHandler<const abiFunction extends AbiFunction>(
		abiFunction: abiFunction,
		fn: HandlerFunction<abiFunction, extra>,
	): Handler<abiFunction, extra>;
	addHandler(abiFunction: string | AbiFunction, fn: (...args: any[]) => any): Handler<any, extra> {
		if (typeof abiFunction === "string") {
			const signature = abiFunction.trim();
			abiFunction = parseAbiItem(
				signature.startsWith("function ") ? signature : `function ${signature}`,
			) as AbiFunction;
		}
		if (abiFunction?.type !== "function") throw new TypeError("expected function");
		const handler = {
			abiFunction,
			selector: toFunctionSelector(abiFunction),
			signature: toFunctionSignature(abiFunction),
			fn,
		};
		this.#handlers.set(handler.selector, handler);
		return handler;
	}

	/** Finds a handler by name, signature, selector, or ABI. */
	findHandler(key: string | AbiFunction): Handler<AbiFunction, extra> | undefined {
		if (typeof key !== "string") key = toFunctionSelector(key);
		if (/^0x[0-9a-f]{8}$/i.test(key)) return this.#handlers.get(key.toLowerCase() as Hex);
		return this.handlers.find((x) => x.abiFunction.name === key || x.signature === key);
	}

	/**
	 * Implements an [ENSIP-10](https://docs.ens.domains/ensip/10) wildcard resolver:
	 * `resolve(name, data)` is answered from the record returned by `resolve`.
	 *
	 * @example
	 * ```ts
	 * ezccip.enableENSIP10({ resolve: (name, ctx) => db.getRecord(name) });
	 * ```
	 */
	enableENSIP10(parameters: ENSIP10Parameters<extra>) {
		return this.addHandler(RESOLVE, createENSIP10Handler(parameters));
	}

	/**
	 * Produces an [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) response.
	 *
	 * @example
	 * ```ts
	 * const { sender, data } = await request.json();
	 * const { data: response, context } = await ezccip.handleRead({ sender, data });
	 * console.log(context.history.toString());
	 * ```
	 */
	async handleRead(parameters: HandleReadParameters<extra>): Promise<HandleReadReturnType> {
		const context = this.#createContext(parameters);
		return { data: await this.#respond(context, parameters.extra as extra), context };
	}

	#createContext(parameters: Omit<HandleReadParameters, "extra">): CallContext {
		const { sender, data } = parameters;
		if (!isAddress(sender, { strict: false })) throw new CCIPReadError("expected sender address", { status: 400 });
		if (!isHex(data) || data.length < 10) throw new CCIPReadError("expected calldata", { status: 400 });
		const origin = parameters.origin ?? this.#origin ?? sender;
		if (!isAddress(origin, { strict: false })) throw new CCIPReadError("invalid origin", { status: 400 });
		const state: ReadState = {
			sender: getAddress(sender),
			request: parameters.request,
			origin: getAddress(origin),
			protocol: parameters.protocol ?? this.#protocol,
			signer: parameters.signer ? toSigner(parameters.signer) : this.#signer,
			ttl: parameters.ttl ?? this.#ttl,
		};
		return new CallContext(state, data.toLowerCase() as Hex, new History());
	}

	async #respond(ctx: CallContext, extra: extra): Promise<Hex> {
		const result = await this.#call(ctx, extra, false);
		const { protocol, signer } = ctx;
		if (protocol === "raw") return result;
		if (!signer) throw new CCIPReadError(`protocol "${protocol}" requires a signer`);
		return signResponse({
			protocol,
			signer,
			origin: ctx.origin,
			expires: BigInt(Math.floor(Date.now() / 1000 + ctx.ttl)),
			calldata: ctx.calldata,
			result,
		});
	}

	async #call(ctx: CallContext, extra: extra, isSubcall: boolean): Promise<Hex> {
		const { calldata, history } = ctx;
		try {
			const selector = getSelector(calldata);
			const handler = this.#handlers.get(selector);
			if (!handler || (isSubcall && selector === MULTICALL_SELECTOR)) {
				throw new CCIPReadError(`unsupported function: ${selector}`, { status: 404 });
			}
			history.name = handler.abiFunction.name;
			try {
				history.args = decodeAbiParameters(handler.abiFunction.inputs, stripSelector(calldata));
			} catch (cause) {
				throw new CCIPReadError("invalid calldata", { status: 400, cause });
			}
			const result = await handler.fn(history.args as never, ctx, extra);
			if (!result) return "0x"; // returns ()
			if (Array.isArray(result)) return encodeAbiParameters(handler.abiFunction.outputs, result as never);
			return bytesLikeToHex(result as BytesLike); // already encoded
		} catch (err) {
			history.error = err;
			throw err;
		}
	}

	/**
	 * Handles an HTTP request: `POST {sender, data}` or `GET .../{sender}/{data}.json`.
	 * Responds with `{data}`, or `{message}` and an HTTP status. CORS is enabled.
	 * Hooks passed here run after the instance hooks.
	 */
	async handleRequest(
		request: Request,
		...[options]: undefined extends extra
			? [options?: HandleRequestOptions<extra>]
			: [options: HandleRequestOptions<extra>]
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
		const hooks = [this.#hooks, options];
		let context: CallContext | undefined;
		let data: Hex;
		try {
			const { sender, data: calldata } = await parseCCIPReadRequest(request);
			context = this.#createContext({ sender, data: calldata, origin: this.#parseOrigin(url), request });
			data = await this.#respond(context, options?.extra as extra);
		} catch (error) {
			const status = error instanceof CCIPReadError ? error.status : 500;
			for (const x of hooks) callHook(x?.onError, { request, url, error, status, context });
			return Response.json({ message: publicErrorMessage(error) }, { status, headers: CORS_HEADERS });
		}
		for (const x of hooks) callHook(x?.onResponse, { request, url, data, context });
		return Response.json({ data }, { headers: CORS_HEADERS });
	}

	/**
	 * Fetch handler, bound to this instance. Only available when `extra` is optional.
	 *
	 * @example
	 * ```ts
	 * Bun.serve({ port: 8000, fetch: ezccip.fetch });
	 * export default { fetch: ezccip.fetch };
	 * ```
	 */
	readonly fetch: FetchHandler<extra> = ((request: Request) =>
		(this.handleRequest as unknown as (request: Request) => Promise<Response>)(request)) as FetchHandler<extra>;
}
