import type { AbiParametersToPrimitiveTypes } from "abitype";
import type { AbiFunction, Address, Hex } from "viem";
import type { History } from "./history.js";
import type { Protocol, Signer } from "./signing.js";

export type Awaitable<T> = T | PromiseLike<T>;

export type BytesLike = Hex | Uint8Array;

/**
 * Information about a request, shared by every call it makes (eg. inside `multicall`).
 * Handlers may change the mutable fields to control how the response is signed.
 *
 * @typeParam extra - Additional fields supplied by the caller, eg. Cloudflare `env`.
 */
export type CallContext<extra extends object = {}> = {
	/** Contract that reverted with `OffchainLookup`. */
	readonly sender: Address;
	/** Calldata from `OffchainLookup` (lowercase). */
	readonly calldata: Hex;
	/** History of the outermost call. */
	readonly history: History;
	/** The HTTP request, if any. */
	readonly request?: Request | undefined;
	/** Contract that will verify the response. (default: `sender`) */
	origin: Address;
	protocol: Protocol;
	signer: Signer | undefined;
	/** Response lifetime in seconds. */
	ttl: number;
} & extra;

/**
 * Return a tuple of outputs (ABI-encoded automatically),
 * already ABI-encoded bytes, or nothing for `returns ()`.
 */
export type FunctionResult<abiFunction extends AbiFunction = AbiFunction> =
	| AbiParametersToPrimitiveTypes<abiFunction["outputs"]>
	| BytesLike
	| void;

/**
 * Implementation of an offchain function.
 *
 * @param args - Decoded arguments.
 * @param context - Request context, shared by every call.
 * @param history - History of this call, eg. set `history.show` to customize logging.
 */
export type FunctionHandler<abiFunction extends AbiFunction = AbiFunction, extra extends object = {}> = (
	args: AbiParametersToPrimitiveTypes<abiFunction["inputs"]>,
	context: CallContext<extra>,
	history: History,
) => Awaitable<FunctionResult<abiFunction>>;

export type RegisteredFunction<abiFunction extends AbiFunction = AbiFunction, extra extends object = {}> = {
	readonly abiFunction: abiFunction;
	readonly selector: Hex;
	/** eg. `"f(uint256,(bool,string)[])"` */
	readonly signature: string;
	readonly handler: FunctionHandler<abiFunction, extra>;
};

/** Makes `extra` required only when it has required fields. */
export type ExtraParameter<extra extends object> = {} extends extra ? { extra?: extra | undefined } : { extra: extra };
