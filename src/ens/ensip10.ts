import type { AbiParametersToPrimitiveTypes } from "abitype";
import {
	type AbiFunction,
	encodeAbiParameters,
	encodeErrorResult,
	type Hex,
	pad,
	size,
	toFunctionSelector,
	zeroAddress,
} from "viem";
import type { ReadContext } from "../context.js";
import { CCIPReadError, encodeErrorString } from "../errors.js";
import type { History } from "../history.js";
import type { Awaitable, BytesLike, HandlerFunction } from "../types.js";
import { bytesLikeToHex, decodeArgs, getSelector, isBytesLike, isEmpty } from "../utils.js";
import {
	ABI,
	ADDR,
	ADDR_COIN_TYPE,
	CONTENTHASH,
	DATA,
	HAS_ADDR,
	MULTICALL,
	NAME,
	PUBKEY,
	type RESOLVE,
	TEXT,
	UNREACHABLE_NAME,
	UNSUPPORTED_RESOLVER_PROFILE,
} from "./abi.js";
import { COIN_TYPE_DEFAULT, COIN_TYPE_ETH, chainFromCoinType, formatCoinType } from "./coin-type.js";
import { dnsDecodeName } from "./dns.js";

type Maybe<T> = Awaitable<T | null | undefined>;

/**
 * Answers ENSIP-10 resolver profiles. Every method is optional.
 * Missing values (`null`, `undefined`, or empty bytes) resolve as empty.
 */
export interface ENSRecord {
	/**
	 * [ENSIP-9](https://docs.ens.domains/ensip/9) / [ENSIP-11](https://docs.ens.domains/ensip/11) address bytes.
	 * EVM coin types (including `60`) must be 20 bytes.
	 */
	addr?(coinType: bigint): Maybe<BytesLike>;
	/** [ENSIP-5](https://docs.ens.domains/ensip/5) */
	text?(key: string): Maybe<string>;
	/** [ENSIP-24](https://docs.ens.domains/ensip/24) */
	data?(key: string): Maybe<BytesLike>;
	/** [ENSIP-7](https://docs.ens.domains/ensip/7) */
	contenthash?(): Maybe<BytesLike>;
	/** [ENSIP-3](https://docs.ens.domains/ensip/3) */
	name?(): Maybe<string>;
	/** [EIP-619](https://github.com/ethereum/EIPs/pull/619): `{x, y}` or already ABI-encoded */
	pubkey?(): Maybe<{ x: bigint | number; y: bigint | number } | BytesLike>;
	/** [ENSIP-4](https://docs.ens.domains/ensip/4): `{type, data}` or already ABI-encoded */
	ABI?(contentTypes: bigint): Maybe<{ type: bigint | number; data: BytesLike } | BytesLike>;
}

export type ProcessENSIP10Options = {
	/** Allow `resolve(name, multicall([...]))`. Subcalls cannot be `multicall()`. (default: true) */
	multicall?: boolean;
	/** Fall back to the [ENSIP-19](https://docs.ens.domains/ensip/19) default address for EVM coin types. (default: true) */
	defaultAddress?: boolean;
	/** Throw a `CCIPReadError` (404) instead of returning `UnsupportedResolverProfile`. (default: false) */
	throwUnsupported?: boolean;
};

/**
 * Answers ENSIP-10 resolver `calldata` from a record and returns the ABI-encoded result.
 * Unsupported profiles are answered with `UnsupportedResolverProfile(bytes4)`.
 */
export function processENSIP10(
	record: ENSRecord | null | undefined,
	calldata: Hex,
	options: ProcessENSIP10Options = {},
	history?: History,
): Promise<Hex> {
	return answer(record ?? undefined, calldata, options, history, false);
}

async function answer(
	record: ENSRecord | undefined,
	calldata: Hex,
	options: ProcessENSIP10Options,
	history: History | undefined,
	isSubcall: boolean,
): Promise<Hex> {
	try {
		const selector = getSelector(calldata);
		const profile = PROFILES.get(selector);
		if (!profile || (profile.abiFunction === MULTICALL && (isSubcall || options.multicall === false))) {
			if (options.throwUnsupported) {
				throw new CCIPReadError(`unsupported resolver profile: ${selector}`, { status: 404 });
			}
			if (history) history.error = "UnsupportedResolverProfile";
			return encodeErrorResult({
				abi: [UNSUPPORTED_RESOLVER_PROFILE],
				args: [pad(selector, { dir: "right", size: 4 })],
			});
		}
		const { abiFunction, answer } = profile;
		const args = decodeArgs(abiFunction, calldata);
		if (history) {
			history.name = abiFunction.name;
			history.show = args.slice(1); // drop namehash
		}
		const result = await answer(record, args as never, options, history);
		return isBytesLike(result) ? bytesLikeToHex(result) : encodeAbiParameters(abiFunction.outputs, result as never);
	} catch (err) {
		if (history) history.error = err;
		throw err;
	}
}

type Answer<abiFunction extends AbiFunction> = (
	record: ENSRecord | undefined,
	args: AbiParametersToPrimitiveTypes<abiFunction["inputs"]>,
	options: ProcessENSIP10Options,
	history: History | undefined,
) => Promise<AbiParametersToPrimitiveTypes<abiFunction["outputs"]> | BytesLike>;

type Profile = { abiFunction: AbiFunction; answer: Answer<AbiFunction> };

function profile<const abiFunction extends AbiFunction>(
	abiFunction: abiFunction,
	answer: Answer<abiFunction>,
): [Hex, Profile] {
	return [toFunctionSelector(abiFunction), { abiFunction, answer: answer as unknown as Answer<AbiFunction> }];
}

const PROFILES = new Map<Hex, Profile>([
	profile(MULTICALL, async (record, [calls], options, history) => {
		if (history) history.show = false;
		const results = calls.map((call) =>
			answer(record, call, options, history?.addChild(call), true).catch(encodeErrorString),
		);
		return [await Promise.all(results)];
	}),
	profile(ADDR, async (record, _, { defaultAddress }) => {
		let value = await record?.addr?.(COIN_TYPE_ETH);
		if (isEmpty(value) && defaultAddress !== false) {
			value = await record?.addr?.(COIN_TYPE_DEFAULT);
		}
		return [isEmpty(value) ? zeroAddress : toEVMAddress(value)];
	}),
	profile(ADDR_COIN_TYPE, async (record, [, coinType], { defaultAddress }, history) => {
		if (history) history.show = [formatCoinType(coinType)];
		const isEVM = chainFromCoinType(coinType) !== undefined;
		let value = await record?.addr?.(coinType);
		if (isEmpty(value) && isEVM && coinType !== COIN_TYPE_DEFAULT && defaultAddress !== false) {
			value = await record?.addr?.(COIN_TYPE_DEFAULT);
		}
		if (isEmpty(value)) return ["0x" as Hex];
		return [isEVM ? toEVMAddress(value) : bytesLikeToHex(value)];
	}),
	profile(HAS_ADDR, async (record, [, coinType], _, history) => {
		if (history) history.show = [formatCoinType(coinType)];
		return [!isEmpty(await record?.addr?.(coinType))];
	}),
	profile(DATA, async (record, [, key]) => {
		const value = await record?.data?.(key);
		return [isEmpty(value) ? "0x" : bytesLikeToHex(value)];
	}),
	profile(TEXT, async (record, [, key]) => [(await record?.text?.(key)) || ""]),
	profile(CONTENTHASH, async (record) => {
		const value = await record?.contenthash?.();
		return [isEmpty(value) ? "0x" : bytesLikeToHex(value)];
	}),
	profile(NAME, async (record) => [(await record?.name?.()) || ""]),
	profile(PUBKEY, async (record) => {
		const value = await record?.pubkey?.();
		if (isBytesLike(value)) return value;
		return value ? [BigInt(value.x), BigInt(value.y)] : [0n, 0n];
	}),
	profile(ABI, async (record, [, contentTypes], _, history) => {
		if (history) history.show = [formatContentTypes(contentTypes)];
		const value = await record?.ABI?.(contentTypes);
		if (isBytesLike(value)) return value;
		return value ? [BigInt(value.type), bytesLikeToHex(value.data)] : [0n, "0x" as Hex];
	}),
	// not implemented:
	// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/resolvers/profiles/IInterfaceResolver.sol
	// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/resolvers/profiles/IDNSRecordResolver.sol
	// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/resolvers/profiles/IDNSZoneResolver.sol
	// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/resolvers/profiles/IVersionableResolver.sol
]);

/** Validates a 20-byte EVM address. */
function toEVMAddress(value: BytesLike): Hex {
	const hex = bytesLikeToHex(value);
	const n = size(hex);
	if (n !== 20) throw new Error(`invalid EVM address: expected 20 bytes, got ${n}`);
	return hex;
}

function formatContentTypes(contentTypes: bigint) {
	const v: string[] = [];
	if (contentTypes & 1n) v.push("JSON");
	if (contentTypes & 2n) v.push("zip(JSON)");
	if (contentTypes & 4n) v.push("CBOR");
	if (contentTypes & 8n) v.push("URI");
	return v.join("|");
}

/** Looks up the record for a name. Return nothing if the name does not exist. */
export type GetRecord = (name: string, ctx: ReadContext, history: History) => Maybe<ENSRecord>;

export type ENSIP10Parameters = ProcessENSIP10Options & {
	/** Looks up the record for a name. */
	resolve: GetRecord;
	/** Answer unknown names with empty records instead of `UnreachableName`. (default: false) */
	unreachableAsEmpty?: boolean;
};

/**
 * Creates a handler for [ENSIP-10](https://docs.ens.domains/ensip/10) `resolve(bytes name, bytes data)`.
 * Note: the name is not normalized.
 */
export function createENSIP10Handler({
	resolve,
	unreachableAsEmpty,
	...options
}: ENSIP10Parameters): HandlerFunction<typeof RESOLVE> {
	return async ([dnsname, data], ctx, history) => {
		const name = dnsDecodeName(dnsname);
		history.show = [name];
		const record = await resolve(name, ctx, history);
		if (!record && !unreachableAsEmpty) {
			history.error = "UnreachableName";
			return encodeErrorResult({ abi: [UNREACHABLE_NAME], args: [dnsname] });
		}
		// already encoded since: abi.decode(abi.encode(x)) == x
		return processENSIP10(record, data, options, history.addInner(data));
	};
}
