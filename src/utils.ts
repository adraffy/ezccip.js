import { bytesToHex, type Hex } from "viem";
import type { BytesLike } from "./types.js";

/** Converts bytes-like to lowercase hex. */
export function bytesLikeToHex(value: BytesLike): Hex {
	return typeof value === "string" ? (value.toLowerCase() as Hex) : bytesToHex(value);
}

export function isBytesLike(value: unknown): value is BytesLike {
	return typeof value === "string" || value instanceof Uint8Array;
}

/** Returns the 4-byte selector of calldata (lowercase). */
export function getSelector(calldata: Hex): Hex {
	return calldata.slice(0, 10).toLowerCase() as Hex;
}

/** Returns calldata without its selector. */
export function stripSelector(calldata: Hex): Hex {
	return `0x${calldata.slice(10)}`;
}

/** Converts a unicode string to a log-safe ascii string with `{XX}` escapes. */
export function asciiize(s: string): string {
	return Array.from(s, (ch) => {
		const cp = ch.codePointAt(0)!;
		return cp >= 32 && cp <= 126 ? ch : `{${cp.toString(16).toUpperCase().padStart(2, "0")}}`;
	}).join("");
}
