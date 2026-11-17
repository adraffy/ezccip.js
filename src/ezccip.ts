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
import { CallContext } from "./context.js";
import { MULTICALL, RESOLVE } from "./ens/abi.js";
import { createENSIP10Handler, type ENSIP10Options, type GetRecord } from "./ens/ensip10.js";
import { CCIPReadError, encodeErrorString } from "./errors.js";
import { History } from "./history.js";
import { type HandleRequestOptions, handleRequest, type RequestHooks } from "./http.js";
import { type Protocol, type Signer, type SignerLike, signResponse, toSigner } from "./signing.js";
import type { BytesLike, ExtraParameter, Handler, HandlerFunction } from "./types.js";
import { bytesLikeToHex, getSelector, stripSelector } from "./utils.js";

export type EZCCIPOptions<extra = undefined> = RequestHooks<extra> & {
	/** Default signer: a private key or eg. a viem `LocalAccount`. */
	signer?: SignerLike | undefined;
	/** Default protocol. (default: `"ens"` with a signer, otherwise `"raw"`) */
	protocol?: Protocol | undefined;
	/** Default response lifetime in seconds. (default: 60) */
	ttl?: number | undefined;
	/** Fallback origin for HTTP requests. */
	origin?: Address | undefined;
	/** Extracts the origin from the URL of an HTTP request, if the path has none. */
	parseOrigin?: ((url: URL) => Address | undefined) | undefined;
};

export type HandleReadParameters<extra = undefined> = ExtraParameter<extra> & {
	sender: Hex;
	/** Calldata from `OffchainLookup`. */
	data: Hex;
	origin?: Address | undefined;
	protocol?: Protocol | undefined;
	signer?: SignerLike | undefined;
	ttl?: number | undefined;
	request?: Request | undefined;
};

export type HandleReadReturnType<extra = undefined> = {
	/** ABI-encoded response for EIP-3668. */
	data: Hex;
	/** Context of the outer call. Its `history` describes the whole response. */
	context: CallContext<extra>;
};

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
 * @typeParam extra - Custom object passed with each request, available as `ctx.extra`.
 */
export class EZCCIP<extra = undefined> {
	readonly options: Readonly<EZCCIPOptions<extra>>;
	readonly #signer: Signer | undefined;
	readonly #handlers = new Map<Hex, Handler<any, extra>>();

	constructor(options: EZCCIPOptions<extra> = {}) {
		this.options = options;
		this.#signer = options.signer ? toSigner(options.signer) : undefined;
		this.addHandler(MULTICALL, async ([calls], ctx) => {
			ctx.history.show = false;
			const results = calls.map((call) =>
				this.#call(call, ctx.nested(ctx.history.addChild()), true).catch(encodeErrorString),
			);
			return [await Promise.all(results)];
		});
	}

	/** Address of the default signer. */
	get signer(): Address | undefined {
		return this.#signer?.address;
	}

	/** Default protocol. */
	get protocol(): Protocol {
		return this.options.protocol ?? (this.#signer ? "ens" : "raw");
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
	addHandler(abiFunction: string | AbiFunction, fn: HandlerFunction<any, extra>): Handler<any, extra> {
		if (typeof abiFunction === "string") {
			const signature = abiFunction.trim();
			abiFunction = parseAbiItem(signature.startsWith("function") ? signature : `function ${signature}`) as AbiFunction;
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
	 * `resolve(name, data)` is answered from the record returned by `getRecord`.
	 */
	enableENSIP10(getRecord: GetRecord<extra>, options?: ENSIP10Options) {
		return this.addHandler(RESOLVE, createENSIP10Handler(getRecord, options));
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
	async handleRead(parameters: HandleReadParameters<extra>): Promise<HandleReadReturnType<extra>> {
		const { sender, data } = parameters;
		if (!isAddress(sender, { strict: false })) {
			throw new CCIPReadError("expected sender address", { status: 400 });
		}
		if (!isHex(data) || data.length < 10) {
			throw new CCIPReadError("expected calldata", { status: 400 });
		}
		const signer = parameters.signer ? toSigner(parameters.signer) : this.#signer;
		const ctx = new CallContext<extra>(
			{
				sender: getAddress(sender),
				calldata: data.toLowerCase() as Hex,
				request: parameters.request,
				extra: parameters.extra as extra,
				origin: getAddress(parameters.origin ?? sender),
				protocol: parameters.protocol ?? this.options.protocol ?? (signer ? "ens" : "raw"),
				signer,
				ttl: parameters.ttl ?? this.options.ttl ?? 60,
			},
			new History(),
		);
		const result = await this.#call(ctx.calldata, ctx, false);
		return { data: await encodeResponse(ctx, result), context: ctx };
	}

	async #call(calldata: Hex, ctx: CallContext<extra>, isSubcall: boolean): Promise<Hex> {
		const { history } = ctx;
		try {
			history.calldata = calldata;
			const selector = getSelector(calldata);
			const handler = this.#handlers.get(selector);
			if (!handler || (isSubcall && selector === MULTICALL_SELECTOR)) {
				throw new CCIPReadError(`unsupported ccip method: ${selector}`);
			}
			history.name = handler.abiFunction.name;
			history.args = decodeAbiParameters(handler.abiFunction.inputs, stripSelector(calldata));
			const result = await handler.fn(history.args as never, ctx);
			if (!result) return "0x"; // returns ()
			if (Array.isArray(result)) return encodeAbiParameters(handler.abiFunction.outputs, result as never);
			return bytesLikeToHex(result as BytesLike); // already encoded
		} catch (err) {
			history.error = err;
			throw err;
		}
	}

	/**
	 * Handles an HTTP request, see {@link handleRequest}.
	 * Hooks passed here run after the instance hooks.
	 */
	handleRequest(
		request: Request,
		...[options]: undefined extends extra
			? [options?: HandleRequestOptions<extra>]
			: [options: HandleRequestOptions<extra>]
	): Promise<Response> {
		return handleRequest(this, request, options);
	}

	/**
	 * Fetch handler, bound to this instance. Use {@link handleRequest} when `extra` is required.
	 *
	 * @example
	 * ```ts
	 * Bun.serve({ port: 8000, fetch: ezccip.fetch });
	 * export default { fetch: ezccip.fetch };
	 * ```
	 */
	readonly fetch = (request: Request): Promise<Response> => handleRequest(this, request);
}

async function encodeResponse(ctx: CallContext<any>, result: Hex): Promise<Hex> {
	const { protocol, signer } = ctx;
	if (protocol === "raw") return result;
	if (protocol !== "ens" && protocol !== "tor") {
		throw new CCIPReadError(`unknown protocol: ${protocol satisfies never}`);
	}
	if (!signer) throw new CCIPReadError(`protocol "${protocol}" requires a signer`);
	return signResponse({
		protocol,
		signer,
		origin: ctx.origin,
		expires: BigInt(Math.floor(Date.now() / 1000) + ctx.ttl),
		request: ctx.calldata,
		result,
	});
}
