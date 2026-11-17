import { hexToBytes } from "viem";
import { CCIPReadError } from "../errors.js";
import type { BytesLike } from "../types.js";

/**
 * Decodes a DNS-encoded name into its labels.
 * Inverse of viem's `packetToBytes()`.
 */
export function dnsDecode(value: BytesLike): string[] {
	const v = typeof value === "string" ? hexToBytes(value) : value;
	const decoder = new TextDecoder(undefined, { fatal: true });
	const labels: string[] = [];
	let pos = 0;
	while (pos < v.length) {
		const n = v[pos++]!;
		if (!n) {
			if (pos !== v.length) break; // empty label must be last
			return labels;
		}
		const end = pos + n;
		if (v.length < end) break; // overflow
		let label: string;
		try {
			label = decoder.decode(v.subarray(pos, end));
		} catch {
			break; // invalid utf8
		}
		pos = end;
		if (label.includes(".")) break;
		labels.push(label);
	}
	throw new CCIPReadError("invalid DNS-encoded name", { status: 400 });
}
