import type { Hex } from "viem";
import { asciiize } from "./utils.js";

/**
 * Log entry for one call. Forms a tree:
 * `multicall()` subcalls are {@link children}, and `resolve()` is followed by its {@link inner} call.
 *
 * `toString()` gives a compact description, eg. `multicall()^2 [resolve(raffy.eth).text(name) f(1)<error>]`.
 */
export class History {
	/** Calldata of this call. */
	calldata?: Hex | undefined;
	/** Function name. Can be overridden for logging. */
	name?: string | undefined;
	/** Decoded arguments. */
	args?: readonly unknown[] | undefined;
	/** Logged instead of `args`: a value, an array, a lazy function, or `false` to hide. */
	show?: unknown;
	error?: unknown;
	/** `multicall()` subcalls. */
	readonly children: History[] = [];
	/** Call answered inside this one, eg. `text()` inside `resolve()`. */
	inner?: History | undefined;

	/** Adds a `multicall()` subcall. */
	addChild(): History {
		const child = new History();
		this.children.push(child);
		return child;
	}

	/** Sets the call answered inside this one. */
	addInner(): History {
		this.inner = new History();
		return this.inner;
	}

	toString(): string {
		const { calldata, name, error, children, inner } = this;
		let desc = name ?? `<${calldata ? calldata.slice(0, 10) : "null"}>`;
		let show = this.show === undefined ? this.args : this.show;
		if (typeof show === "function") show = show();
		const shown = show === undefined || show === null || show === false ? [] : Array.isArray(show) ? show : [show];
		desc += `(${shown.map((x) => (typeof x === "string" ? asciiize(x) : String(x))).join(",")})`;
		if (children.length) desc += `^${children.length} [${children.join(" ")}]`;
		if (error !== undefined) desc += `<${error instanceof Error ? error.message : String(error)}>`;
		if (inner) desc += `.${inner}`;
		return desc;
	}
}
