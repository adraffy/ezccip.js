import type { AbiParametersToPrimitiveTypes } from "abitype";
import { AbiError, AbiFunction, AbiItem, AbiParameters, Address, Hex } from "ox";
import { RESOLVE_ABI, type ENSRecord, type ProcessENSIP10Options, processENSIP10 } from "./ensip10.ts";
import { History } from "./history.ts";
import { encodeENSResponse, type Protocol } from "./protocol.ts";
import { type Signer, type SignerLike, toSigner } from "./signer.ts";
import {
	type Awaitable,
	type BytesLike,
	CCIPReadError,
	encodeErrorMessage,
	labelsFromDnsEncoded,
	toHex,
} from "./utils.ts";

/** Information about the incoming request, shared by every call. Handlers may modify the mutable fields. */
export type CallContext<extra extends object = {}> = {
	/** Contract that triggered `OffchainLookup`. */
	readonly sender: Address.Address;
	/** Original calldata (lowercase). */
	readonly calldata: Hex.Hex;
	/** Root history. */
	readonly history: History;
	/** Contract that will verify the response (defaults to `sender`). */
	origin: Address.Address;
	protocol: Protocol;
	signer: Signer | undefined;
	/** Response lifetime in seconds. */
	ttl: number;
	/** The HTTP request, if served through {@link EZCCIP.fetch} or {@link EZCCIP.handleRequest}. */
	readonly request?: Request;
} & extra;

/**
 * Return a tuple of outputs (ABI-encoded automatically),
 * already ABI-encoded bytes, or nothing for `returns ()`.
 */
export type HandlerResult<
	abiFunction extends AbiFunction.AbiFunction = AbiFunction.AbiFunction,
> = AbiParametersToPrimitiveTypes<abiFunction["outputs"]> | BytesLike | void;

/**
 * Implementation of an offchain function.
 * @param args - decoded arguments
 * @param context - shared request context
 * @param history - history for this call (eg. customize logging via `history.show`)
 */
export type Handler<
	abiFunction extends AbiFunction.AbiFunction = AbiFunction.AbiFunction,
	extra extends object = {},
> = (
	args: AbiParametersToPrimitiveTypes<abiFunction["inputs"]>,
	context: CallContext<extra>,
	history: History
) => Awaitable<HandlerResult<abiFunction>>;

export type RegisteredHandler<
	abiFunction extends AbiFunction.AbiFunction = AbiFunction.AbiFunction,
	extra extends object = {},
> = {
	readonly abiFunction: abiFunction;
	readonly selector: Hex.Hex;
	readonly signature: string;
	readonly handler: Handler<abiFunction, extra>;
};

/** Human-readable function signature, with or without the `function` prefix. */
type ParseFunction<signature extends string> = Extract<
	AbiFunction.from.ReturnType<
		signature extends `function ${string}` ? signature : `function ${signature}`
	>,
	AbiFunction.AbiFunction
>;

export type RecordFunction<extra extends object = {}> = (
	name: string,
	context: CallContext<extra>,
	history: History
) => Awaitable<ENSRecord | null | undefined>;

export type ENSIP10Options = Omit<ProcessENSIP10Options, "history"> & {
	/** Answer unknown names with empty records instead of `UnreachableName`. (default: false) */
	unreachableAsEmpty?: boolean;
};

export type EZCCIPOptions = {
	/** Default signer. */
	signer?: SignerLike;
	/** Default signing protocol. (default: `"ens"` if `signer` is set, otherwise `"raw"`) */
	protocol?: Protocol;
	/** Default response lifetime in seconds. (default: 60) */
	ttl?: number;
	/** Maximum `multicall()` depth. `0` disables multicall. (default: 2) */
	recursionLimit?: number;
	/** Fallback origin used by {@link EZCCIP.fetch} if none is found in the URL. */
	origin?: Address.Address;
	/** Extract origin from the request URL. (default: first `/0x{40}` path component) */
	parseOrigin?: (url: URL) => Address.Address | undefined;
	/** Logging for {@link EZCCIP.fetch}. `true` uses `console.log`. (default: false) */
	log?: boolean | ((...args: unknown[]) => void);
	/** Format errors before logging. */
	formatError?: (error: unknown) => unknown;
};

export type HandleReadParameters<extra extends object = {}> = {
	sender: Hex.Hex;
	/** Calldata from `OffchainLookup`. */
	data: Hex.Hex;
	origin?: Address.Address;
	protocol?: Protocol;
	signer?: SignerLike;
	ttl?: number;
	request?: Request;
} & ({} extends extra ? { extra?: extra } : { extra: extra });

export type HandleReadResult<extra extends object = {}> = {
	/** ABI-encoded response for EIP-3668. */
	data: Hex.Hex;
	history: History;
	context: CallContext<extra>;
};

const MULTICALL = AbiFunction.fromAbi(RESOLVE_ABI, "multicall");
const MULTICALL_SELECTOR = AbiFunction.getSelector(MULTICALL);
const RESOLVE = AbiFunction.fromAbi(RESOLVE_ABI, "resolve");
const UnreachableName = AbiError.fromAbi(RESOLVE_ABI, "UnreachableName");

/**
 * Turnkey [EIP-3668: CCIP-Read](https://eips.ethereum.org/EIPS/eip-3668) handler.
 *
 * @example
 * ```ts
 * const ezccip = new EZCCIP({ signer: privateKey });
 * ezccip.register("function add(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a + b]);
 * export default ezccip; // Bun, Deno, Cloudflare Workers, etc.
 * ```
 *
 * @typeParam extra - Additional fields passed to {@link EZCCIP.handleRequest} and merged into {@link CallContext}.
 */
export class EZCCIP<extra extends object = {}> {
	readonly #handlers = new Map<Hex.Hex, RegisteredHandler<any, extra>>();
	readonly options: Readonly<EZCCIPOptions>;
	readonly #signer: Signer | undefined;
	readonly #log: ((...args: unknown[]) => void) | undefined;

	constructor(options: EZCCIPOptions = {}) {
		this.options = options;
		this.#signer = options.signer ? toSigner(options.signer) : undefined;
		this.#log =
			options.log === true
				? (...a) => console.log(new Date(), ...a)
				: options.log || undefined;
		// multicall is always enabled, disable with { recursionLimit: 0 }
		this.register(MULTICALL, async ([calls], context, history) => {
			history.show = false;
			return [
				await Promise.all(
					calls.map((call) =>
						this.#handleCall(call, context, history.enter()).catch(encodeErrorMessage)
					)
				),
			];
		});
	}

	/** Address of the default signer. */
	get signer(): Address.Address | undefined {
		return this.#signer?.address;
	}

	/** All registered handlers. */
	get handlers(): RegisteredHandler<AbiFunction.AbiFunction, extra>[] {
		return [...this.#handlers.values()];
	}

	/**
	 * Register a handler for an offchain function.
	 * Arguments and outputs are typed from the function.
	 * Registering the same selector again replaces the handler.
	 *
	 * @example
	 * ```ts
	 * ezccip.register("function plus(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a + b]);
	 * ```
	 */
	register<const signature extends string>(
		signature: signature,
		handler: Handler<ParseFunction<signature>, extra>
	): RegisteredHandler<ParseFunction<signature>, extra>;
	register<const abiFunction extends AbiFunction.AbiFunction>(
		abiFunction: abiFunction,
		handler: Handler<abiFunction, extra>
	): RegisteredHandler<abiFunction, extra>;
	register(
		abiFunction: string | AbiFunction.AbiFunction,
		handler: Handler<any, extra>
	): RegisteredHandler<any, extra> {
		if (typeof abiFunction === "string") {
			const signature = abiFunction.trim();
			abiFunction = AbiFunction.from(
				signature.startsWith("function") ? signature : `function ${signature}`
			) as AbiFunction.AbiFunction;
		}
		if (abiFunction?.type !== "function") throw new TypeError("expected function");
		const registered: RegisteredHandler<any, extra> = {
			abiFunction,
			selector: AbiFunction.getSelector(abiFunction),
			signature: AbiItem.getSignature(abiFunction),
			handler,
		};
		this.#handlers.set(registered.selector, registered);
		return registered;
	}

	/** Find a handler by selector, name, signature, or function. */
	findHandler(
		key: string | AbiFunction.AbiFunction
	): RegisteredHandler<AbiFunction.AbiFunction, extra> | undefined {
		if (typeof key !== "string") key = AbiFunction.getSelector(key);
		if (/^0x[0-9a-f]{8}$/i.test(key)) {
			return this.#handlers.get(key.toLowerCase() as Hex.Hex);
		}
		for (const x of this.#handlers.values()) {
			if (x.abiFunction.name === key || x.signature === key) return x;
		}
	}

	/**
	 * Implement an [ENSIP-10](https://docs.ens.domains/ensip/10) wildcard resolver
	 * which handles `resolve(bytes name, bytes data)` automatically.
	 *
	 * Note: the name is not normalized.
	 */
	enableENSIP10(getRecord: RecordFunction<extra>, options: ENSIP10Options = {}) {
		const { unreachableAsEmpty, ...processOptions } = options;
		return this.register(RESOLVE, async ([dnsname, data], context, history) => {
			const name = labelsFromDnsEncoded(dnsname).join(".");
			history.show = [name];
			const record = await getRecord(name, context, history);
			if (!record && !unreachableAsEmpty) {
				history.error = "UnreachableName";
				return AbiError.encode(UnreachableName, [dnsname]);
			}
			if (record) history.record = record;
			// returns raw since: abi.decode(abi.encode(x)) == x
			return processENSIP10(record ?? undefined, data, {
				...processOptions,
				history: history.chain(),
			});
		});
	}

	/**
	 * Produce an [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) response.
	 *
	 * @example
	 * ```ts
	 * const { sender, data } = await req.json();
	 * const { data: response, history } = await ezccip.handleRead({ sender, data });
	 * return Response.json({ data: response });
	 * ```
	 */
	async handleRead(parameters: HandleReadParameters<extra>): Promise<HandleReadResult<extra>> {
		const { sender, data } = parameters;
		if (!Address.validate(sender, { strict: false })) {
			throw new CCIPReadError("expected sender address", { status: 400 });
		}
		if (!Hex.validate(data) || data.length < 10) {
			throw new CCIPReadError("expected calldata", { status: 400 });
		}
		const signer = parameters.signer ? toSigner(parameters.signer) : this.#signer;
		const history = new History(this.options.recursionLimit ?? 2);
		const context = {
			...parameters.extra,
			sender: Address.checksum(sender),
			calldata: data.toLowerCase() as Hex.Hex,
			origin: Address.checksum(parameters.origin ?? sender),
			protocol: parameters.protocol ?? this.options.protocol ?? (signer ? "ens" : "raw"),
			signer,
			ttl: parameters.ttl ?? this.options.ttl ?? 60,
			request: parameters.request,
			history,
		} as CallContext<extra>;
		const result = await this.#handleCall(context.calldata, context, history);
		return { data: await encodeResponse(context, result), history, context };
	}

	async #handleCall(
		calldata: Hex.Hex,
		context: CallContext<extra>,
		history: History
	): Promise<Hex.Hex> {
		try {
			history.calldata = calldata;
			const selector = calldata.slice(0, 10).toLowerCase() as Hex.Hex;
			const handler = this.#handlers.get(selector);
			if (!handler || (!history.level && handler.selector === MULTICALL_SELECTOR)) {
				throw new CCIPReadError(`unsupported ccip method: ${selector}`);
			}
			const { abiFunction } = handler;
			history.name = abiFunction.name;
			const args = AbiParameters.decode(abiFunction.inputs, `0x${calldata.slice(10)}`);
			history.args = history.show = args;
			const res = await handler.handler(args as never, context, history);
			if (!res) return "0x"; // falsy implies return ()
			if (Array.isArray(res)) return AbiParameters.encode(abiFunction.outputs, res as never);
			return toHex(res as BytesLike); // already encoded
		} catch (err) {
			history.error = err;
			throw err;
		}
	}

	/**
	 * Handle an HTTP request with extra context.
	 * Supports `POST {sender, data}` and `GET .../{sender}/{data}.json`.
	 * The origin is parsed from the URL using {@link EZCCIPOptions.parseOrigin}.
	 */
	async handleRequest(
		request: Request,
		...[extra]: {} extends extra ? [extra?: extra] : [extra: extra]
	): Promise<Response> {
		const url = new URL(request.url);
		const headers = { "access-control-allow-origin": "*" };
		try {
			let sender: Hex.Hex;
			let data: Hex.Hex;
			let path = url.pathname;
			switch (request.method) {
				case "OPTIONS":
					return new Response(null, {
						status: 204,
						headers: {
							...headers,
							"access-control-allow-methods": "GET, POST, OPTIONS",
							"access-control-allow-headers": "*",
						},
					});
				case "POST": {
					let json: { sender: Hex.Hex; data: Hex.Hex };
					try {
						json = await request.json();
					} catch (cause) {
						throw new CCIPReadError("expected JSON", { status: 400, cause });
					}
					({ sender, data } = json);
					break;
				}
				case "GET": {
					const match = path.match(/\/(0x[0-9a-f]{40})\/(0x[0-9a-f]*)(?:\.json)?$/i);
					if (!match) throw new CCIPReadError("expected /{sender}/{data}", { status: 400 });
					sender = match[1] as Hex.Hex;
					data = match[2] as Hex.Hex;
					path = path.slice(0, match.index);
					break;
				}
				default:
					throw new CCIPReadError("unsupported http method", { status: 405 });
			}
			const origin =
				path.match(/\/(0x[0-9a-f]{40})(?=\/|$)/i)?.[1] as Address.Address | undefined ??
				this.options.parseOrigin?.(url) ??
				this.options.origin;
			const { data: response, history } = await this.handleRead({
				sender,
				data,
				origin,
				request,
				extra,
			} as HandleReadParameters<extra>);
			this.#log?.(url.pathname, history.toString());
			return Response.json({ data: response }, { headers });
		} catch (err) {
			this.#log?.(request.method, url.pathname, this.options.formatError?.(err) ?? err);
			const status = err instanceof CCIPReadError ? err.status : 500;
			const message = err instanceof Error ? err.message : String(err);
			return Response.json({ message }, { status, headers });
		}
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
	readonly fetch = (request: Request): Promise<Response> =>
		(this.handleRequest as unknown as (request: Request) => Promise<Response>)(request);
}


async function encodeResponse(context: CallContext<any>, result: Hex.Hex): Promise<Hex.Hex> {
	switch (context.protocol) {
		case "raw":
			return result;
		case "ens": {
			if (!context.signer) throw new CCIPReadError(`protocol "ens" requires a signer`);
			return encodeENSResponse({
				signer: context.signer,
				origin: context.origin,
				expires: BigInt(Math.floor(Date.now() / 1000) + context.ttl),
				request: context.calldata,
				result,
			});
		}
		default:
			throw new CCIPReadError(`unknown protocol: ${context.protocol}`);
	}
}
