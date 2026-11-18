import type { AbiParametersToPrimitiveTypes } from "abitype";
import type { AbiFunction, Hex } from "viem";
import type { ReadContext } from "./context.js";
import type { History } from "./history.js";

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
 * Implementation of an offchain function: `(args, ctx, history) => result`.
 *
 * @param args - Decoded arguments.
 * @param ctx - The request, shared by every call in it. Handlers may change how the response is signed.
 * @param history - Log entry for this call: rename it or replace the shown arguments.
 */
export type HandlerFunction<abiFunction extends AbiFunction = AbiFunction> = (
	args: AbiParametersToPrimitiveTypes<abiFunction["inputs"]>,
	ctx: ReadContext,
	history: History,
) => Awaitable<HandlerResult<abiFunction>>;

/** A function added with `addFunctionHandler()` or `addAbiHandler()`. */
export type Handler<abiFunction extends AbiFunction = AbiFunction> = {
	readonly abiFunction: abiFunction;
	readonly selector: Hex;
	/** eg. `"f(uint256,(bool,string)[])"` */
	readonly signature: string;
	readonly fn: HandlerFunction<abiFunction>;
};
