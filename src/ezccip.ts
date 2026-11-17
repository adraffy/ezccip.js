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
import { MULTICALL, RESOLVE } from "./ens/abi.js";
import { createENSIP10Handler, type ENSIP10Options, type GetRecord } from "./ens/ensip10.js";
import { CCIPReadError, encodeErrorString } from "./errors.js";
import { History } from "./history.js";
import { type HandleRequestOptions, handleRequest, type RequestHooks } from "./http.js";
import { type Protocol, type Signer, type SignerLike, signResponse, toSigner } from "./signing.js";
import type { BytesLike, CallContext, ExtraParameter, FunctionHandler, RegisteredFunction } from "./types.js";
import { bytesLikeToHex, getSelector, stripSelector } from "./utils.js";

export type EZCCIPOptions<extra extends object = {}> = RequestHooks<extra> & {
	/** Default signer: a private key or eg. a viem `LocalAccount`. */
	signer?: SignerLike | undefined;
	/** Default protocol. (default: `"ens"` with a signer, otherwise `"raw"`) */
	protocol?: Protocol | undefined;
	/** Default response lifetime in seconds. (default: 60) */
	ttl?: number | undefined;
	/** Maximum `multicall()` nesting. `0` disables multicall. (default: 2) */
	recursionLimit?: number | undefined;
	/** Fallback origin for HTTP requests. */
	origin?: Address | undefined;
	/** Extracts the origin from the URL of an HTTP request, if the path has none. */
	parseOrigin?: ((url: URL) => Address | undefined) | undefined;
};

export type HandleReadParameters<extra extends object = {}> = ExtraParameter<extra> & {
	sender: Hex;
	/** Calldata from `OffchainLookup`. */
	data: Hex;
	origin?: Address | undefined;
	protocol?: Protocol | undefined;
	signer?: SignerLike | undefined;
	ttl?: number | undefined;
	request?: Request | undefined;
};

export type HandleReadReturnType<extra extends object = {}> = {
	/** ABI-encoded response for EIP-3668. */
	data: Hex;
	history: History;
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
 * @example
 * ```ts
 * const ezccip = new EZCCIP({ signer: privateKey });
 * ezccip.register("function plus(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a + b]);
 * export default { fetch: ezccip.fetch };
 * ```
 *
 * @typeParam extra - Additional fields passed with each request and merged into {@link CallContext}.
 */
export class EZCCIP<extra extends object = {}> {
	readonly options: Readonly<EZCCIPOptions<extra>>;
	readonly #signer: Signer | undefined;
	readonly #functions = new Map<Hex, RegisteredFunction<any, extra>>();

	constructor(options: EZCCIPOptions<extra> = {}) {
		this.options = options;
		this.#signer = options.signer ? toSigner(options.signer) : undefined;
		// always enabled, see: recursionLimit
		this.register(MULTICALL, async ([calls], context, history) => {
			history.show = false;
			const results = calls.map((call) => this.#call(call, context, history.enter()).catch(encodeErrorString));
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

	/** Registered functions, including `multicall`. */
	get functions(): RegisteredFunction<AbiFunction, extra>[] {
		return [...this.#functions.values()];
	}

	/**
	 * Registers an offchain function. Arguments and outputs are typed from the function.
	 * Registering the same selector again replaces it.
	 *
	 * @example
	 * ```ts
	 * ezccip.register("function plus(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a + b]);
	 * ezccip.register(AbiFunction.fromAbi(abi, "f"), ([x], context, history) => [x]);
	 * ```
	 */
	register<const signature extends string>(
		signature: signature,
		handler: FunctionHandler<ParseFunction<signature>, extra>,
	): RegisteredFunction<ParseFunction<signature>, extra>;
	register<const abiFunction extends AbiFunction>(
		abiFunction: abiFunction,
		handler: FunctionHandler<abiFunction, extra>,
	): RegisteredFunction<abiFunction, extra>;
	register(abiFunction: string | AbiFunction, handler: FunctionHandler<any, extra>): RegisteredFunction<any, extra> {
		if (typeof abiFunction === "string") {
			const signature = abiFunction.trim();
			abiFunction = parseAbiItem(signature.startsWith("function") ? signature : `function ${signature}`) as AbiFunction;
		}
		if (abiFunction?.type !== "function") throw new TypeError("expected function");
		const registered = {
			abiFunction,
			selector: toFunctionSelector(abiFunction),
			signature: toFunctionSignature(abiFunction),
			handler,
		};
		this.#functions.set(registered.selector, registered);
		return registered;
	}

	/** Finds a registered function by name, signature, selector, or ABI. */
	getFunction(key: string | AbiFunction): RegisteredFunction<AbiFunction, extra> | undefined {
		if (typeof key !== "string") key = toFunctionSelector(key);
		if (/^0x[0-9a-f]{8}$/i.test(key)) return this.#functions.get(key.toLowerCase() as Hex);
		return this.functions.find((x) => x.abiFunction.name === key || x.signature === key);
	}

	/**
	 * Implements an [ENSIP-10](https://docs.ens.domains/ensip/10) wildcard resolver:
	 * `resolve(name, data)` is answered from the record returned by `getRecord`.
	 */
	enableENSIP10(getRecord: GetRecord<extra>, options?: ENSIP10Options) {
		return this.register(RESOLVE, createENSIP10Handler(getRecord, options));
	}

	/**
	 * Produces an [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) response.
	 *
	 * @example
	 * ```ts
	 * const { sender, data } = await request.json();
	 * const { data: response, history } = await ezccip.handleRead({ sender, data });
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
		const history = new History(this.options.recursionLimit ?? 2);
		const context = {
			...parameters.extra,
			sender: getAddress(sender),
			calldata: data.toLowerCase() as Hex,
			origin: getAddress(parameters.origin ?? sender),
			protocol: parameters.protocol ?? this.options.protocol ?? (signer ? "ens" : "raw"),
			signer,
			ttl: parameters.ttl ?? this.options.ttl ?? 60,
			request: parameters.request,
			history,
		} as CallContext<extra>;
		const result = await this.#call(context.calldata, context, history);
		return { data: await encodeResponse(context as CallContext, result), history, context };
	}

	async #call(calldata: Hex, context: CallContext<extra>, history: History): Promise<Hex> {
		try {
			history.calldata = calldata;
			const selector = getSelector(calldata);
			const fn = this.#functions.get(selector);
			if (!fn || (!history.level && selector === MULTICALL_SELECTOR)) {
				throw new CCIPReadError(`unsupported ccip method: ${selector}`);
			}
			history.name = fn.abiFunction.name;
			const args = decodeAbiParameters(fn.abiFunction.inputs, stripSelector(calldata));
			history.args = history.show = args;
			const result = await fn.handler(args as never, context, history);
			if (!result) return "0x"; // returns ()
			if (Array.isArray(result)) return encodeAbiParameters(fn.abiFunction.outputs, result as never);
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
		...[options]: {} extends extra ? [options?: HandleRequestOptions<extra>] : [options: HandleRequestOptions<extra>]
	): Promise<Response> {
		return handleRequest(this, request, options);
	}

	/**
	 * Fetch handler, bound to this instance.
	 *
	 * @example
	 * ```ts
	 * Bun.serve({ port: 8000, fetch: ezccip.fetch });
	 * export default { fetch: ezccip.fetch };
	 * ```
	 */
	readonly fetch = (request: Request): Promise<Response> => handleRequest(this, request);
}

async function encodeResponse(context: CallContext, result: Hex): Promise<Hex> {
	const { protocol, signer } = context;
	if (protocol === "raw") return result;
	if (protocol !== "ens" && protocol !== "tor") {
		throw new CCIPReadError(`unknown protocol: ${protocol satisfies never}`);
	}
	if (!signer) throw new CCIPReadError(`protocol "${protocol}" requires a signer`);
	return signResponse({
		protocol,
		signer,
		origin: context.origin,
		expires: BigInt(Math.floor(Date.now() / 1000) + context.ttl),
		request: context.calldata,
		result,
	});
}
