import { Abi, AbiError, AbiFunction, AbiItem, AbiParameters, Hex } from "ox";
import type { History } from "./history.js";
import {
	type Awaitable,
	type BytesLike,
	CCIPReadError,
	COIN_TYPE_DEFAULT,
	COIN_TYPE_ETH,
	chainFromCoinType,
	encodeErrorMessage,
	toHex,
} from "./utils.js";

export const RESOLVE_ABI = Abi.from([
	"function resolve(bytes name, bytes data) view returns (bytes)",
	"function multicall(bytes[] calls) view returns (bytes[])",
	//
	"function name(bytes32 node) view returns (string)",
	"function addr(bytes32 node) view returns (address)",
	"function addr(bytes32 node, uint256 coinType) view returns (bytes)",
	"function hasAddr(bytes32 node, uint256 coinType) view returns (bool)",
	"function data(bytes32 node, string key) view returns (bytes)",
	"function text(bytes32 node, string key) view returns (string)",
	"function contenthash(bytes32 node) view returns (bytes)",
	"function pubkey(bytes32 node) view returns (uint256 x, uint256 y)",
	"function ABI(bytes32 node, uint256 contentTypes) view returns (uint256 contentType, bytes data)",
	//
	"error UnsupportedResolverProfile(bytes4 selector)",
	"error UnreachableName(bytes name)",
]);

/** A record which can answer ENSIP-10 resolver profiles. Every method is optional. */
export interface ENSRecord {
	/** [ENSIP-9](https://docs.ens.domains/ensip/9) / [ENSIP-11](https://docs.ens.domains/ensip/11) */
	addr?(coinType: bigint): Awaitable<BytesLike | null | undefined>;
	/** [ENSIP-5](https://docs.ens.domains/ensip/5) */
	text?(key: string): Awaitable<string | null | undefined>;
	/** [ENSIP-24](https://docs.ens.domains/ensip/24) */
	data?(key: string): Awaitable<BytesLike | null | undefined>;
	/** [ENSIP-7](https://docs.ens.domains/ensip/7) */
	contenthash?(): Awaitable<BytesLike | null | undefined>;
	/** [EIP-619](https://github.com/ethereum/EIPs/pull/619) &mdash; either `{x, y}` or raw-encoded */
	pubkey?(): Awaitable<
		{ x: bigint | number; y: bigint | number } | BytesLike | null | undefined
	>;
	/** [ENSIP-3](https://docs.ens.domains/ensip/3) */
	name?(): Awaitable<string | null | undefined>;
	/** [ENSIP-4](https://docs.ens.domains/ensip/4) &mdash; either `{type, data}` or raw-encoded */
	ABI?(
		contentTypes: number
	): Awaitable<
		{ type: bigint | number; data: BytesLike } | BytesLike | null | undefined
	>;
}

export type ProcessENSIP10Options = {
	/** Allow `multicall()` inside `resolve()`. (default: true) */
	multicall?: boolean;
	/** Fallback to the [ENSIP-19](https://docs.ens.domains/ensip/19) default address for EVM coin types. (default: true) */
	defaultAddress?: boolean;
	/** Throw instead of returning `UnsupportedResolverProfile`. (default: false) */
	throwErrors?: boolean;
	history?: History;
};

type ProfileFunction = (
	record: ENSRecord | undefined,
	args: readonly any[],
	ctx: {
		options: ProcessENSIP10Options;
		history: History | undefined;
	}
) => Promise<readonly unknown[] | Hex.Hex>;

const UnsupportedResolverProfile = AbiError.fromAbi(
	RESOLVE_ABI,
	"UnsupportedResolverProfile"
);

const PROFILES: { [signature: string]: ProfileFunction | undefined } = {
	async "multicall(bytes[])"(record, [calls], { options, history }) {
		if (history) history.show = false;
		return [
			await Promise.all(
				(calls as Hex.Hex[]).map((call) =>
					processENSIP10(record, call, {
						...options,
						history: history?.enter(),
					}).catch(encodeErrorMessage)
				)
			),
		];
	},
	async "addr(bytes32)"(record, _, { options }) {
		let value = await record?.addr?.(COIN_TYPE_ETH);
		if (!value && options.defaultAddress !== false) {
			value = await record?.addr?.(COIN_TYPE_DEFAULT);
		}
		// note: this truncates the value to the first 20 bytes
		return [`0x${(value ? toHex(value).slice(2, 42) : "").padStart(40, "0")}`];
	},
	async "addr(bytes32,uint256)"(record, [, coinType], { options, history }) {
		if (history) history.show = [coinTypeString(coinType)];
		let value = await record?.addr?.(coinType);
		if (
			!value &&
			options.defaultAddress !== false &&
			chainFromCoinType(coinType)
		) {
			value = await record?.addr?.(COIN_TYPE_DEFAULT);
		}
		return [value ? toHex(value) : "0x"];
	},
	async "hasAddr(bytes32,uint256)"(record, [, coinType], { history }) {
		if (history) history.show = [coinTypeString(coinType)];
		return [!!(await record?.addr?.(coinType))];
	},
	async "data(bytes32,string)"(record, [, key]) {
		const value = await record?.data?.(key);
		return [value ? toHex(value) : "0x"];
	},
	async "text(bytes32,string)"(record, [, key]) {
		return [(await record?.text?.(key)) || ""];
	},
	async "contenthash(bytes32)"(record) {
		const value = await record?.contenthash?.();
		return [value ? toHex(value) : "0x"];
	},
	async "name(bytes32)"(record) {
		return [(await record?.name?.()) || ""];
	},
	async "pubkey(bytes32)"(record) {
		const value = await record?.pubkey?.();
		if (isBytesLike(value)) return toHex(value);
		return value ? [value.x, value.y] : [0n, 0n];
	},
	async "ABI(bytes32,uint256)"(record, [, contentTypes], { history }) {
		const types = Number(contentTypes);
		if (history) history.show = [abiTypesString(types)];
		const value = await record?.ABI?.(types);
		if (isBytesLike(value)) return toHex(value);
		return value ? [value.type, toHex(value.data)] : [0n, "0x"];
	},
	// not implemented:
	// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/resolvers/profiles/IInterfaceResolver.sol
	// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/resolvers/profiles/IDNSRecordResolver.sol
	// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/resolvers/profiles/IDNSZoneResolver.sol
	// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/resolvers/profiles/IVersionableResolver.sol
};

const PROFILE_MAP = new Map(
	RESOLVE_ABI.filter((x) => x.type === "function").flatMap((abiFunction) => {
		const fn = PROFILES[AbiItem.getSignature(abiFunction)];
		return fn ? [[AbiFunction.getSelector(abiFunction), { abiFunction, fn }]] : [];
	})
);

/**
 * Applies ENSIP-10 `calldata` to a record and returns the ABI-encoded response.
 * Unsupported profiles are answered with `UnsupportedResolverProfile(bytes4)`.
 */
export async function processENSIP10(
	record: ENSRecord | undefined,
	calldata: Hex.Hex,
	options: ProcessENSIP10Options = {}
): Promise<Hex.Hex> {
	const { history } = options;
	try {
		if (history) history.calldata = calldata;
		const selector = calldata.slice(0, 10).toLowerCase() as Hex.Hex;
		const profile = PROFILE_MAP.get(selector);
		if (
			!profile ||
			(options.multicall === false && profile.abiFunction.name === "multicall")
		) {
			if (options.throwErrors) {
				throw new CCIPReadError(`unsupported resolver profile: ${selector}`, {
					status: 400,
				});
			}
			if (history) history.error = "UnsupportedResolverProfile";
			return AbiError.encode(UnsupportedResolverProfile, [
				Hex.padRight(selector, 4),
			]);
		}
		const { abiFunction, fn } = profile;
		const args = AbiParameters.decode(abiFunction.inputs, `0x${calldata.slice(10)}`);
		if (history) {
			history.name = abiFunction.name;
			history.args = args;
			history.show = args.slice(1); // drop namehash
		}
		const res = await fn(record, args, { options, history });
		return typeof res === "string"
			? res // raw encoding
			: AbiParameters.encode(abiFunction.outputs, res as never);
	} catch (err) {
		if (history) history.error = err;
		throw err;
	}
}

function isBytesLike(x: unknown): x is BytesLike {
	return typeof x === "string" || x instanceof Uint8Array;
}

// shorter coin names
function coinTypeString(coinType: bigint) {
	const evm = coinType ^ COIN_TYPE_DEFAULT;
	return evm < COIN_TYPE_DEFAULT ? `evm:${evm}` : coinType;
}

// visible abi types
function abiTypesString(types: number) {
	const v: string[] = [];
	if (types & 1) v.push("JSON");
	if (types & 2) v.push("zip(JSON)");
	if (types & 4) v.push("CBOR");
	if (types & 8) v.push("URI");
	return v.join("|");
}
