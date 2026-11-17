import type { Hex } from "viem";
import { asciiize } from "./utils.js";

/**
 * Builds a one-line description of what was requested and how it was answered, for logging.
 * One per call: `multicall()` subcalls are {@link children}, and the call inside `resolve()` is {@link inner}.
 *
 * eg. `multicall()^2 [resolve(raffy.eth).text(name) f(1)<error>]`
 */
export class History {
	/** Function name, or the selector until it's known. Handlers may rename it. */
	name: string;
	/** Logged arguments. Handlers may replace them, or set `false` to hide them. */
	show: readonly unknown[] | false = [];
	error?: unknown;
	readonly children: History[] = [];
	inner?: History | undefined;

	constructor(calldata: Hex) {
		this.name = `<${calldata.slice(0, 10)}>`;
	}

	/** Adds a `multicall()` subcall. */
	addChild(calldata: Hex): History {
		const child = new History(calldata);
		this.children.push(child);
		return child;
	}

	/** Sets the call answered inside this one, eg. `text()` inside `resolve()`. */
	addInner(calldata: Hex): History {
		this.inner = new History(calldata);
		return this.inner;
	}

	toString(): string {
		const { name, show, error, children, inner } = this;
		const args = show ? show.map((x) => (typeof x === "string" ? asciiize(x) : String(x))) : [];
		let desc = `${name}(${args.join(",")})`;
		if (children.length) desc += `^${children.length} [${children.join(" ")}]`;
		if (error !== undefined) desc += `<${error instanceof Error ? error.message : String(error)}>`;
		if (inner) desc += `.${inner}`;
		return desc;
	}
}
