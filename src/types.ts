import type { AbiParametersToPrimitiveTypes } from "abitype";
import type { AbiFunction, Hex } from "viem";
import type { CallContext } from "./context.js";

export type Awaitable<T> = T | PromiseLike<T>;

export type BytesLike = Hex | Uint8Array;

/**
 * Return a tuple of outputs (ABI-encoded automatically),
 * already ABI-encoded bytes, or nothing for `returns ()`.
 */
export type HandlerResult<abiFunction extends AbiFunction = AbiFunction> =
	| AbiParametersToPrimitiveTypes<abiFunction["outputs"]>
	| BytesLike
	| void;

/** Implementation of an offchain function: `(args, ctx) => result`. */
export type HandlerFunction<abiFunction extends AbiFunction = AbiFunction, extra = undefined> = (
	args: AbiParametersToPrimitiveTypes<abiFunction["inputs"]>,
	ctx: CallContext<extra>,
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
