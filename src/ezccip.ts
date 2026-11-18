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
import type { ReadContext } from "./context.js";
import { MULTICALL, RESOLVE } from "./ens/abi.js";
import { createENSIP10Handler, type ENSIP10Parameters } from "./ens/ensip10.js";
import { CCIPReadError, encodeErrorString } from "./errors.js";
import { History } from "./history.js";
import { checkProtocol, type Protocol, type Signer, signResponse, toSigner } from "./signing.js";
import type { BytesLike, Handler, HandlerFunction, ResponseOptions } from "./types.js";
import { bytesLikeToHex, checkOrigin, checkTTL, decodeArgs, getSelector } from "./utils.js";

/** Defaults for every request: `protocol`, `signer`, and `ttl`. */
export type EZCCIPOptions = ResponseOptions;

export type HandleRequestOptions = ResponseOptions & {
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
 * const { data } = await ezccip.handleRequest(sender, calldata);
 * ```
 */
export class EZCCIP {
	readonly #signer: Signer | undefined;
	readonly #protocol: Protocol | undefined;
	readonly #ttl: number;
	readonly #handlers = new Map<Hex, Handler<any>>();

	constructor({ signer, protocol, ttl = 60 }: EZCCIPOptions = {}) {
		this.#signer = signer ? toSigner(signer) : undefined;
		this.#protocol = protocol && checkProtocol(protocol);
		this.#ttl = checkTTL(ttl);
	}

	/** Address of the default signer. */
	get signerAddress(): Address | undefined {
		return this.#signer?.address;
	}

	/** Default protocol. */
	get protocol(): Protocol {
		return this.#protocol ?? (this.#signer ? "ens" : "raw");
	}

	/** All handlers. (`multicall` is built in, not a handler.) */
	get handlers(): Handler[] {
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
		fn: HandlerFunction<ParseFunction<signature>>,
	): Handler<ParseFunction<signature>>;
	addHandler<const abiFunction extends AbiFunction>(
		abiFunction: abiFunction,
		fn: HandlerFunction<abiFunction>,
	): Handler<abiFunction>;
	addHandler(abiFunction: string | AbiFunction, fn: (...args: any[]) => any): Handler<any> {
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
		this.addHandler(RESOLVE, createENSIP10Handler(parameters));
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
		const signer = ctx.signer ? toSigner(ctx.signer) : undefined;
		const protocol = ctx.protocol ? checkProtocol(ctx.protocol) : signer ? "ens" : "raw";
		const origin = checkOrigin(ctx.origin);
		const ttl = checkTTL(ctx.ttl);
		if (protocol === "raw") return result;
		if (!signer) throw new CCIPReadError(`protocol "${protocol}" requires a signer`);
		const expires = BigInt(Math.floor(Date.now() / 1000 + ttl));
		return signResponse({ protocol, signer, origin, expires, calldata, result });
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
