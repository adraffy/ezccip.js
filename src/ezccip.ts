import type { ExtractAbiFunction, ExtractAbiFunctionNames } from "abitype";
import {
	type Abi,
	type AbiFunction,
	type Address,
	encodeAbiParameters,
	getAddress,
	type Hex,
	isAddress,
	isHex,
	type ParseAbi,
	type ParseAbiItem,
	parseAbi,
	parseAbiItem,
	toFunctionSelector,
	toFunctionSignature,
} from "viem";
import type { ReadContext } from "./context.js";
import { MULTICALL, RESOLVE } from "./ens/abi.js";
import { createENSIP10Handler, type ENSIP10Parameters } from "./ens/ensip10.js";
import { CCIPReadError, encodeErrorString } from "./errors.js";
import { History } from "./history.js";
import { checkProtocol, type Protocol, type Signer, type SignerLike, signResponse, toSigner } from "./signing.js";
import type { BytesLike, Handler, HandlerFunction } from "./types.js";
import { bytesLikeToHex, checkOrigin, checkTTL, decodeArgs, getSelector } from "./utils.js";

/** How responses are signed. `handleRequest()` can override them per request, and handlers on `ctx`. */
export type EZCCIPOptions = {
	/** (default: `"ens"` with a signer, otherwise `"raw"`) */
	protocol?: Protocol | undefined;
	/** A private key or eg. a viem `LocalAccount`. */
	signer?: SignerLike | undefined;
	/** Response lifetime in seconds. (default: 60) */
	ttl?: number | undefined;
};

/** Per-request overrides of {@link EZCCIPOptions}, plus the request's origin and extra values. */
export type HandleRequestOptions = EZCCIPOptions & {
	/** Contract that will verify the response. (default: `sender`) */
	origin?: Address | undefined;
	/** Custom values for handlers, as `ctx.extra`. (default: `{}`) */
	extra?: Record<string, unknown> | undefined;
};

export type HandleRequestReturnType = {
	/** ABI-encoded response for EIP-3668. */
	data: Hex;
	/** The request, as the handlers left it. */
	context: ReadContext;
	/** What was requested and how it was answered, eg. `resolve(raffy.eth).text(name)`. */
	history: History;
};

/** Human-readable function signature, eg. `"function f(uint256 x) returns (string)"`. */
type FunctionSignature = `function ${string}`;

type ParseFunction<signature extends FunctionSignature> = Extract<ParseAbiItem<signature>, AbiFunction>;

type ToFunction<fn extends FunctionSignature | AbiFunction> = fn extends FunctionSignature ? ParseFunction<fn> : fn;

type ToAbi<abi extends Abi | readonly string[]> = abi extends readonly string[] ? ParseAbi<abi> : abi;

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
 * ezccip.addFunctionHandler("function plus(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a + b]);
 * const { data } = await ezccip.handleRequest(sender, calldata);
 * ```
 */
export class EZCCIP {
	#signer: Signer | undefined;
	#protocol: Protocol;
	readonly #ttl: number;
	readonly #handlers = new Map<Hex, Handler<any>>();

	constructor({ signer, protocol, ttl = 60 }: EZCCIPOptions = {}) {
		this.#signer = signer ? toSigner(signer) : undefined;
		this.#protocol = checkProtocol(protocol ?? (signer ? "ens" : "raw"));
		this.#ttl = checkTTL(ttl);
	}

	/** Default signer. Set a private key or eg. a viem `LocalAccount`, or `undefined` to clear it. */
	get signer(): Signer | undefined {
		return this.#signer;
	}
	set signer(signer: SignerLike | undefined) {
		this.#signer = signer ? toSigner(signer) : undefined;
	}

	/** Address of the default signer. */
	get signerAddress(): Address | undefined {
		return this.#signer?.address;
	}

	/** Default protocol. (default: `"ens"` if constructed with a signer, otherwise `"raw"`) */
	get protocol(): Protocol {
		return this.#protocol;
	}
	set protocol(protocol: Protocol) {
		this.#protocol = checkProtocol(protocol);
	}

	/** All handlers. (`multicall` is built in, not a handler.) */
	get handlers(): Handler[] {
		return [...this.#handlers.values()];
	}

	/**
	 * Adds a handler for an offchain function, given as a human-readable signature or an `AbiFunction`.
	 * Arguments and outputs are typed from the function. Adding the same selector again replaces it.
	 *
	 * @example
	 * ```ts
	 * ezccip.addFunctionHandler("function plus(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a + b]);
	 * ezccip.addFunctionHandler(getAbiItem({ abi, name: "f" }), ([x], ctx) => [x]);
	 * ```
	 */
	addFunctionHandler<const fn extends FunctionSignature | AbiFunction>(
		fn: fn,
		handler: HandlerFunction<ToFunction<fn>>,
	): Handler<ToFunction<fn>> {
		const abiFunction = (typeof fn === "string" ? parseAbiItem(fn as string) : fn) as AbiFunction;
		if (abiFunction?.type !== "function") throw new TypeError("expected function");
		const selector = toFunctionSelector(abiFunction);
		if (selector === MULTICALL_SELECTOR) throw new TypeError("multicall is built in");
		const added: Handler<any> = { abiFunction, selector, signature: toFunctionSignature(abiFunction), fn: handler };
		this.#handlers.set(selector, added);
		return added;
	}

	/**
	 * Adds a handler for a function of an ABI, by name. The ABI is an `Abi` or human-readable signatures,
	 * which may declare structs. The name must not be overloaded: for overloads, use {@link addFunctionHandler}
	 * with `getAbiItem({ abi, name, args })`.
	 *
	 * @example
	 * ```ts
	 * const abi = ["struct Point { uint256 x; uint256 y; }", "function flip(Point p) returns (Point)"] as const;
	 * ezccip.addAbiHandler(abi, "flip", ([{ x, y }]) => [{ x: y, y: x }]);
	 * ```
	 */
	addAbiHandler<const abi extends Abi | readonly string[], functionName extends ExtractAbiFunctionNames<ToAbi<abi>>>(
		abi: abi,
		functionName: functionName,
		handler: HandlerFunction<ExtractAbiFunction<ToAbi<abi>, functionName>>,
	): Handler<ExtractAbiFunction<ToAbi<abi>, functionName>> {
		const items: Abi = typeof abi[0] === "string" ? parseAbi(abi as readonly string[]) : (abi as Abi);
		const matches = items.filter((x) => x.type === "function" && x.name === functionName);
		if (matches.length > 1) throw new TypeError(`overloaded function: ${functionName}`);
		if (!matches[0]) throw new TypeError(`unknown function: ${functionName}`);
		return this.addFunctionHandler(matches[0] as AbiFunction, handler as never) as never;
	}

	/** Finds a handler by name, signature, selector, or ABI. */
	findHandler(key: string | AbiFunction): Handler | undefined {
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
	enableENSIP10(parameters: ENSIP10Parameters): this {
		this.addFunctionHandler(RESOLVE, createENSIP10Handler(parameters));
		return this;
	}

	/**
	 * Answers an [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) request.
	 * Throws a {@link CCIPReadError} (with an HTTP status) for bad input, or whatever a handler throws.
	 *
	 * @example
	 * ```ts
	 * const { sender, data: calldata } = await request.json();
	 * const { data, history } = await ezccip.handleRequest(sender, calldata, { extra: { ip } });
	 * console.log(history.toString());
	 * ```
	 */
	async handleRequest(
		sender: Hex,
		calldata: Hex,
		{ origin = sender, protocol, signer, ttl, extra = {} }: HandleRequestOptions = {},
	): Promise<HandleRequestReturnType> {
		if (!isAddress(sender, { strict: false })) throw new CCIPReadError("expected sender address", { status: 400 });
		if (!isHex(calldata) || calldata.length < 10) throw new CCIPReadError("expected calldata", { status: 400 });
		if (!isAddress(origin, { strict: false })) throw new CCIPReadError("invalid origin", { status: 400 });
		calldata = calldata.toLowerCase() as Hex;
		const context: ReadContext = {
			sender: getAddress(sender),
			calldata,
			origin: getAddress(origin),
			protocol: protocol ?? this.#protocol,
			signer: signer ?? this.#signer,
			ttl: ttl ?? this.#ttl,
			extra,
		};
		const history = new History(calldata);
		const result = await this.#call(calldata, context, history, false);
		return { data: await this.#sign(calldata, result, context), context, history };
	}

	/** Signs a result as the handlers left the context. */
	async #sign(calldata: Hex, result: Hex, ctx: ReadContext): Promise<Hex> {
		const { protocol, signer } = ctx;
		const origin = checkOrigin(ctx.origin);
		const ttl = checkTTL(ctx.ttl);
		if (protocol === "raw") return result;
		if (!signer) throw new CCIPReadError(`protocol "${protocol}" requires a signer`);
		const expires = BigInt(Math.floor(Date.now() / 1000 + ttl));
		// an unknown protocol throws in getResponseHash()
		return signResponse({ protocol, signer: toSigner(signer), origin, expires, calldata, result });
	}

	async #call(calldata: Hex, ctx: ReadContext, history: History, isSubcall: boolean): Promise<Hex> {
		try {
			const selector = getSelector(calldata);
			if (selector === MULTICALL_SELECTOR && !isSubcall) {
				history.name = MULTICALL.name;
				history.show = false;
				const [calls] = decodeArgs(MULTICALL, calldata) as readonly [readonly Hex[]];
				const results = calls.map((call) =>
					this.#call(call, ctx, history.addChild(call), true).catch(encodeErrorString),
				);
				return encodeAbiParameters(MULTICALL.outputs, [await Promise.all(results)]);
			}
			const handler = this.#handlers.get(selector);
			if (!handler) throw new CCIPReadError(`unsupported function: ${selector}`, { status: 404 });
			history.name = handler.abiFunction.name;
			const args = decodeArgs(handler.abiFunction, calldata);
			history.show = args;
			const result = await handler.fn(args as never, ctx, history);
			if (!result) return "0x"; // returns ()
			if (Array.isArray(result)) return encodeAbiParameters(handler.abiFunction.outputs, result as never);
			return bytesLikeToHex(result as BytesLike); // already encoded
		} catch (err) {
			history.error = err;
			throw err;
		}
	}
}
