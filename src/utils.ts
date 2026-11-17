import { AbiError, Bytes, Hex } from "ox";

export type Awaitable<T> = T | PromiseLike<T>;
export type BytesLike = Hex.Hex | Uint8Array;

/** [ENSIP-9](https://docs.ens.domains/ensip/9) coin type for Ethereum. */
export const COIN_TYPE_ETH = 60n;
/** [ENSIP-19](https://docs.ens.domains/ensip/19) default EVM coin type. */
export const COIN_TYPE_DEFAULT = 0x8000_0000n;

/** Error with an HTTP status code. */
export class CCIPReadError extends Error {
	override name = "CCIPReadError";
	readonly status: number;
	constructor(
		message: string,
		{ status = 500, cause }: { status?: number; cause?: unknown } = {}
	) {
		super(message, { cause });
		this.status = status;
	}
}

/** Returns the EVM chain id for an [ENSIP-11](https://docs.ens.domains/ensip/11) coin type, or `0` if not an EVM coin type. */
export function chainFromCoinType(coinType: bigint): number {
	if (coinType === COIN_TYPE_ETH) return 1;
	coinType ^= COIN_TYPE_DEFAULT;
	return coinType >= 0n && coinType < COIN_TYPE_DEFAULT ? Number(coinType) : 0;
}

/** Converts bytes-like to lowercase hex. */
export function toHex(value: BytesLike): Hex.Hex {
	return typeof value === "string"
		? (value.toLowerCase() as Hex.Hex)
		: Hex.fromBytes(value);
}

/** Decodes a DNS-encoded name into an array of labels (inverse of `Bytes.fromString` + DNS-encode). */
export function labelsFromDnsEncoded(value: BytesLike): string[] {
	const v = typeof value === "string" ? Bytes.fromHex(value) : value;
	const labels: string[] = [];
	const decoder = new TextDecoder(undefined, { fatal: true });
	let pos = 0;
	while (true) {
		const n = v[pos++];
		if (!n) {
			// empty label must be last
			if (pos !== v.length) break;
			return labels;
		}
		if (v.length < pos + n) break; // overflow
		let label: string;
		try {
			label = decoder.decode(v.subarray(pos, (pos += n)));
		} catch {
			break;
		}
		if (label.includes(".")) break;
		labels.push(label);
	}
	throw new CCIPReadError("invalid DNS-encoded name", { status: 400 });
}

/** Converts a unicode string to a log-safe ascii string with `{XX}` escapes. */
export function asciiize(s: string): string {
	return Array.from(s, (ch) => {
		const cp = ch.codePointAt(0)!;
		return cp >= 32 && cp <= 126
			? ch
			: `{${cp.toString(16).toUpperCase().padStart(2, "0")}}`;
	}).join("");
}

/** Encodes an error as `error Error(string)`. */
export function encodeErrorMessage(error: unknown): Hex.Hex {
	const message = error instanceof Error ? error.message : String(error);
	return AbiError.encode(AbiError.from("error Error(string)"), [message]);
}

/** DNS-encodes a name (inverse of {@link labelsFromDnsEncoded}). Does not normalize. */
export function dnsEncode(name: string): Hex.Hex {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	if (name) {
		for (const label of name.split(".")) {
			const v = encoder.encode(label);
			if (!v.length || v.length > 255) {
				throw new CCIPReadError(`invalid label length: ${v.length}`, { status: 400 });
			}
			parts.push(Uint8Array.of(v.length), v);
		}
	}
	parts.push(Uint8Array.of(0));
	return Hex.fromBytes(Bytes.concat(...parts));
}
