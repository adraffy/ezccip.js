import type { Hex } from "ox";
import { asciiize } from "./utils.js";

type Show = unknown;

/**
 * Collects information about a response as it is generated.
 * `toString()` produces a compact description suitable for logging.
 */
export class History {
	/** Remaining recursion depth (counts down). */
	readonly level: number;
	/** Nested calls, eg. `multicall()` children. */
	readonly children: History[] = [];
	/** Subsequent call, eg. `resolve()` followed by the inner call. */
	next?: History;
	calldata?: Hex.Hex;
	/** Function name. */
	name?: string;
	/** Decoded arguments. */
	args?: readonly unknown[];
	/** Arguments shown in the log: a value, an array, a lazy function, or `false` to hide. */
	show?: Show | (() => Show);
	error?: unknown;
	/** The resolved record (set by ENSIP-10 handler). */
	record?: unknown;

	constructor(level: number) {
		this.level = level;
	}

	/** Creates a child history (one level deeper). */
	enter(): History {
		if (this.level <= 0) throw new Error("recursion limit");
		const child = new History(this.level - 1);
		this.children.push(child);
		return child;
	}

	/** Creates a sibling history that follows this one. */
	chain(): History {
		return (this.next = new History(this.level));
	}

	/** Returns the last history in the chain. */
	last(): History {
		let h: History = this;
		while (h.next) h = h.next;
		return h;
	}

	toString(): string {
		const { calldata, name, error, children, next } = this;
		let desc = name ?? `<${calldata ? calldata.slice(0, 10) : "null"}>`;
		desc += "(";
		let show = this.show;
		if (typeof show === "function") show = show();
		if (show !== undefined && show !== false && show !== null) {
			const v = Array.isArray(show) ? show : [show];
			desc += v
				.map((x) => (typeof x === "string" ? asciiize(x) : String(x)))
				.join(",");
		}
		desc += ")";
		if (children.length) desc += `^${children.length} [${children.join(" ")}]`;
		if (error !== undefined) desc += `<${formatError(error)}>`;
		if (next) desc += `.${next}`;
		return desc;
	}
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
