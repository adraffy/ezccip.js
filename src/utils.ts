import {
	type AbiFunction,
	type Address,
	bytesToHex,
	decodeAbiParameters,
	getAddress,
	type Hex,
	isAddress,
	isHex,
} from "viem";
import { CCIPReadError } from "./errors.js";
import type { BytesLike } from "./types.js";

/** Converts bytes-like to lowercase hex. Throws on strings that aren't hex. */
export function bytesLikeToHex(value: BytesLike): Hex {
	if (typeof value !== "string") return bytesToHex(value);
	if (!isHex(value, { strict: true })) throw new TypeError(`expected hex: ${String(value).slice(0, 20)}`);
	return value.toLowerCase() as Hex;
}

export function isBytesLike(value: unknown): value is BytesLike {
	return typeof value === "string" || value instanceof Uint8Array;
}

/** True for `null`, `undefined`, `"0x"`, and empty `Uint8Array`. */
export function isEmpty(value: BytesLike | null | undefined): value is null | undefined {
	return value === null || value === undefined || (typeof value === "string" ? value.length <= 2 : !value.length);
}

/** Returns the 4-byte selector of calldata (lowercase). */
export function getSelector(calldata: Hex): Hex {
	return calldata.slice(0, 10).toLowerCase() as Hex;
}

/** Returns calldata without its selector. */
export function stripSelector(calldata: Hex): Hex {
	return `0x${calldata.slice(10)}`;
}

/** Decodes the arguments of calldata. Throws a 400 {@link CCIPReadError} if they don't match the function. */
export function decodeArgs(abiFunction: AbiFunction, calldata: Hex): readonly unknown[] {
	try {
		return decodeAbiParameters(abiFunction.inputs, stripSelector(calldata));
	} catch (cause) {
		throw new CCIPReadError("invalid calldata", { status: 400, cause });
	}
}

/** Validates and checksums an origin address. */
export function checkOrigin(origin: string): Address {
	if (!isAddress(origin, { strict: false })) throw new TypeError(`invalid origin: ${origin}`);
	return getAddress(origin);
}

/** Validates a response lifetime: a finite, non-negative number of seconds. */
export function checkTTL(ttl: number): number {
	if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 0) throw new TypeError(`invalid ttl: ${ttl}`);
	return ttl;
}

/** Converts a unicode string to a log-safe ascii string with `{XX}` escapes. */
export function asciiize(s: string): string {
	return Array.from(s, (ch) => {
		const cp = ch.codePointAt(0)!;
		return cp >= 32 && cp <= 126 ? ch : `{${cp.toString(16).toUpperCase().padStart(2, "0")}}`;
	}).join("");
}
