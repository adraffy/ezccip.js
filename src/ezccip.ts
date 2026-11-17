import {
	type AbiFunction,
	type Address,
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
import { type CallContext, Context, defaultProtocol, type ReadState } from "./context.js";
import { MULTICALL, RESOLVE } from "./ens/abi.js";
import { createENSIP10Handler, type ENSIP10Parameters } from "./ens/ensip10.js";
import { CCIPReadError, encodeErrorString, publicErrorMessage } from "./errors.js";
import {
	CORS_HEADERS,
	callHook,
	type HandleRequestOptions,
	originFromPath,
	parseCCIPReadRequest,
	type RequestHooks,
} from "./http.js";
import { checkProtocol, type Protocol, type Signer, signResponse, toSigner } from "./signing.js";
import type { BytesLike, ExtraParameter, Handler, HandlerFunction, ResponseOptions } from "./types.js";
import { bytesLikeToHex, checkOrigin, checkTTL, decodeArgs, getSelector } from "./utils.js";

export type EZCCIPOptions = RequestHooks &
	ResponseOptions & {
		/**
		 * Extracts the origin from the URL of an HTTP request.
		 * (default: the first `/0x{40}` path component, see {@link originFromPath})
		 */
		parseOrigin?: ((url: URL) => Address | undefined) | undefined;
	};

export type HandleReadParameters<extra = undefined> = ExtraParameter<extra> &
	ResponseOptions & {
		sender: Hex;
		/** Calldata from `OffchainLookup`. */
		data: Hex;
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
 * `multicall(bytes[])` is built in (not a handler): it is only answered as the outer call,
 * and its subcalls cannot be `multicall()`.
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
		this.#signer = signer ? toSigner(signer) : undefined;
		this.#protocol = protocol && checkProtocol(protocol);
		this.#ttl = checkTTL(ttl);
		this.#origin = origin === undefined ? undefined : checkOrigin(origin);
		this.#parseOrigin = parseOrigin ?? ((url) => originFromPath(url.pathname));
		this.#hooks = { onResponse, onError };
	}

	/** Address of the default signer. */
	get signerAddress(): Address | undefined {
		return this.#signer?.address;
	}

	/** Default protocol. */
	get protocol(): Protocol {
		return this.#protocol ?? defaultProtocol(this.#signer);
	}

	/** All handlers. (`multicall` is built in, not a handler.) */
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
		const selector = toFunctionSelector(abiFunction);
		if (selector === MULTICALL_SELECTOR) throw new TypeError("multicall is built in");
		const handler = { abiFunction, selector, signature: toFunctionSignature(abiFunction), fn };
		this.#handlers.set(selector, handler);
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
	 *
	 * @returns this instance, for chaining.
	 */
	enableENSIP10(parameters: ENSIP10Parameters<extra>): this {
		this.addHandler(RESOLVE, createENSIP10Handler(parameters));
		return this;
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

	#createContext(parameters: Omit<HandleReadParameters, "extra">): Context {
		const { sender, data } = parameters;
		if (!isAddress(sender, { strict: false })) throw new CCIPReadError("expected sender address", { status: 400 });
		if (!isHex(data) || data.length < 10) throw new CCIPReadError("expected calldata", { status: 400 });
		const origin = parameters.origin ?? this.#origin ?? sender;
		if (!isAddress(origin, { strict: false })) throw new CCIPReadError("invalid origin", { status: 400 });
		const state: ReadState = {
			sender: getAddress(sender),
			request: parameters.request,
			origin: getAddress(origin),
			protocol: parameters.protocol ? checkProtocol(parameters.protocol) : this.#protocol,
			signer: parameters.signer ? toSigner(parameters.signer) : this.#signer,
			ttl: parameters.ttl === undefined ? this.#ttl : checkTTL(parameters.ttl),
		};
		return new Context(state, data.toLowerCase() as Hex);
	}

	async #respond(ctx: Context, extra: extra): Promise<Hex> {
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

	async #call(ctx: Context, extra: extra, isSubcall: boolean): Promise<Hex> {
		const { calldata, history } = ctx;
		try {
			const selector = getSelector(calldata);
			if (selector === MULTICALL_SELECTOR && !isSubcall) {
				history.name = MULTICALL.name;
				history.show = false;
				const [calls] = decodeArgs(MULTICALL, calldata) as readonly [readonly Hex[]];
				const results = calls.map((call) => this.#call(ctx.child(call), extra, true).catch(encodeErrorString));
				return encodeAbiParameters(MULTICALL.outputs, [await Promise.all(results)]);
			}
			const handler = this.#handlers.get(selector);
			if (!handler) throw new CCIPReadError(`unsupported function: ${selector}`, { status: 404 });
			history.name = handler.abiFunction.name;
			const args = decodeArgs(handler.abiFunction, calldata);
			history.show = args;
			const result = await handler.fn(args as never, ctx, extra);
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
	 * Responds with `{data}`, or `{message}` and an HTTP status. CORS is enabled unless `cors: false`.
	 * Hooks passed here run after the instance hooks.
	 */
	async handleRequest(
		request: Request,
		...[options]: undefined extends extra
			? [options?: HandleRequestOptions<extra>]
			: [options: HandleRequestOptions<extra>]
	): Promise<Response> {
		const cors = options?.cors !== false;
		const headers = cors ? CORS_HEADERS : undefined;
		if (request.method === "OPTIONS" && cors) {
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
		let context: Context | undefined;
		let data: Hex;
		try {
			const { sender, data: calldata } = await parseCCIPReadRequest(request);
			context = this.#createContext({ sender, data: calldata, origin: this.#parseOrigin(url), request });
			data = await this.#respond(context, options?.extra as extra);
		} catch (error) {
			const status = error instanceof CCIPReadError ? error.status : 500;
			for (const x of hooks) callHook(x?.onError, { request, url, error, status, context });
			return Response.json({ message: publicErrorMessage(error) }, { status, headers });
		}
		for (const x of hooks) callHook(x?.onResponse, { request, url, data, context });
		return Response.json({ data }, { headers });
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
	readonly fetch = ((request: Request) => this.handleRequest(request, {} as never)) as FetchHandler<extra>;
}
