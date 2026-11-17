import type { AbiParametersToPrimitiveTypes } from "abitype";
import type { AbiFunction, Hex } from "viem";
import type { CallContext } from "./context.js";
import type { Protocol, SignerLike } from "./signing.js";

export type Awaitable<T> = T | PromiseLike<T>;

export type BytesLike = Hex | Uint8Array;

/**
 * Return a tuple of outputs (ABI-encoded automatically) or already ABI-encoded bytes.
 * Functions without outputs may also return nothing.
 */
export type HandlerResult<abiFunction extends AbiFunction = AbiFunction> =
	| AbiParametersToPrimitiveTypes<abiFunction["outputs"]>
	| BytesLike
	| (abiFunction["outputs"] extends readonly [] ? void : never);

/**
 * Implementation of an offchain function: `(args, ctx, extra) => result`.
 *
 * @param args - Decoded arguments.
 * @param ctx - This call's context.
 * @param extra - Custom object passed with the request, eg. `{ env }` on Cloudflare.
 */
export type HandlerFunction<abiFunction extends AbiFunction = AbiFunction, extra = undefined> = (
	args: AbiParametersToPrimitiveTypes<abiFunction["inputs"]>,
	ctx: CallContext,
	extra: extra,
) => Awaitable<HandlerResult<abiFunction>>;

/** A function added with `addHandler()`. */
export type Handler<abiFunction extends AbiFunction = AbiFunction, extra = undefined> = {
	readonly abiFunction: abiFunction;
	readonly selector: Hex;
	/** eg. `"f(uint256,(bool,string)[])"` */
	readonly signature: string;
	readonly fn: HandlerFunction<abiFunction, extra>;
};

/** `extra` is optional when it may be `undefined`, otherwise required. */
export type ExtraParameter<extra> = undefined extends extra ? { extra?: extra } : { extra: extra };

/** How a response is signed. Defaults on `EZCCIP`, per request in `handleRequest()`, or set by handlers on `ctx`. */
export type ResponseOptions = {
	/** (default: `"ens"` with a signer, otherwise `"raw"`) */
	protocol?: Protocol | undefined;
	/** A private key or eg. a viem `LocalAccount`. */
	signer?: SignerLike | undefined;
	/** Response lifetime in seconds. (default: 60) */
	ttl?: number | undefined;
};
