import {
	decodeAbiParameters,
	encodeAbiParameters,
	encodeErrorResult,
	type Hex,
	pad,
	toFunctionSelector,
	toFunctionSignature,
} from "viem";
import type { CallContext } from "../context.js";
import { CCIPReadError, encodeErrorString } from "../errors.js";
import type { History } from "../history.js";
import type { Awaitable, BytesLike, HandlerFunction } from "../types.js";
import { bytesLikeToHex, getSelector, isBytesLike, stripSelector } from "../utils.js";
import { type RESOLVE, RESOLVE_ABI, UNREACHABLE_NAME, UNSUPPORTED_RESOLVER_PROFILE } from "./abi.js";
import { COIN_TYPE_DEFAULT, COIN_TYPE_ETH, chainFromCoinType, formatCoinType } from "./coin-type.js";
import { dnsDecode } from "./dns.js";

type Maybe<T> = Awaitable<T | null | undefined>;

/** Answers ENSIP-10 resolver profiles. Every method is optional; missing values resolve as empty. */
export interface ENSRecord {
	/** [ENSIP-9](https://docs.ens.domains/ensip/9) / [ENSIP-11](https://docs.ens.domains/ensip/11) */
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
	ABI?(contentTypes: bigint): Maybe<{ type: bigint; data: BytesLike } | BytesLike>;
}

export type ProcessENSIP10Options = {
	/** Allow `resolve(name, multicall([...]))`. Subcalls cannot be `multicall()`. (default: true) */
	multicall?: boolean;
	/** Fall back to the [ENSIP-19](https://docs.ens.domains/ensip/19) default address for EVM coin types. (default: true) */
	defaultAddress?: boolean;
	/** Throw instead of returning `UnsupportedResolverProfile`. (default: false) */
	throwErrors?: boolean;
	/** Records how the calldata was answered. */
	history?: History | undefined;
};

/**
 * Answers ENSIP-10 resolver `calldata` from a record and returns the ABI-encoded result.
 * Unsupported profiles are answered with `UnsupportedResolverProfile(bytes4)`.
 */
export async function processENSIP10(
	record: ENSRecord | null | undefined,
	calldata: Hex,
	options: ProcessENSIP10Options = {},
): Promise<Hex> {
	return process(record, calldata, options, false);
}

async function process(
	record: ENSRecord | null | undefined,
	calldata: Hex,
	options: ProcessENSIP10Options,
	isSubcall: boolean,
): Promise<Hex> {
	const { history } = options;
	try {
		if (history) history.calldata = calldata;
		const selector = getSelector(calldata);
		const profile = PROFILES.get(selector);
		if (!profile || (profile.abiFunction.name === "multicall" && (isSubcall || options.multicall === false))) {
			if (options.throwErrors) {
				throw new CCIPReadError(`unsupported resolver profile: ${selector}`, { status: 400 });
			}
			if (history) history.error = "UnsupportedResolverProfile";
			return encodeErrorResult({
				abi: [UNSUPPORTED_RESOLVER_PROFILE],
				args: [pad(selector, { dir: "right", size: 4 })],
			});
		}
		const { abiFunction, answer } = profile;
		const args = decodeAbiParameters(abiFunction.inputs, stripSelector(calldata));
		if (history) {
			history.name = abiFunction.name;
			history.args = args;
			history.show = args.slice(1); // drop namehash
		}
		const result = await answer(record ?? undefined, args, options);
		return isBytesLike(result) ? bytesLikeToHex(result) : encodeAbiParameters(abiFunction.outputs, result as never);
	} catch (err) {
		if (history) history.error = err;
		throw err;
	}
}

type Answer = (
	record: ENSRecord | undefined,
	args: readonly any[],
	options: ProcessENSIP10Options,
) => Promise<readonly unknown[] | BytesLike>;

// keyed by signature, see: RESOLVE_ABI
const ANSWERS: Record<string, Answer> = {
	async "multicall(bytes[])"(record, [calls], options) {
		const { history } = options;
		if (history) history.show = false;
		return [
			await Promise.all(
				(calls as Hex[]).map((call) =>
					process(record, call, { ...options, history: history?.addChild() }, true).catch(encodeErrorString),
				),
			),
		];
	},
	async "addr(bytes32)"(record, _, options) {
		let value = await record?.addr?.(COIN_TYPE_ETH);
		if (!value && options.defaultAddress !== false) {
			value = await record?.addr?.(COIN_TYPE_DEFAULT);
		}
		// truncate or pad to 20 bytes
		return [`0x${(value ? bytesLikeToHex(value).slice(2, 42) : "").padStart(40, "0")}`];
	},
	async "addr(bytes32,uint256)"(record, [, coinType], { history, defaultAddress }) {
		if (history) history.show = [formatCoinType(coinType)];
		let value = await record?.addr?.(coinType);
		if (!value && defaultAddress !== false && chainFromCoinType(coinType)) {
			value = await record?.addr?.(COIN_TYPE_DEFAULT);
		}
		return [value ? bytesLikeToHex(value) : "0x"];
	},
	async "hasAddr(bytes32,uint256)"(record, [, coinType], { history }) {
		if (history) history.show = [formatCoinType(coinType)];
		return [!!(await record?.addr?.(coinType))];
	},
	async "data(bytes32,string)"(record, [, key]) {
		const value = await record?.data?.(key);
		return [value ? bytesLikeToHex(value) : "0x"];
	},
	async "text(bytes32,string)"(record, [, key]) {
		return [(await record?.text?.(key)) || ""];
	},
	async "contenthash(bytes32)"(record) {
		const value = await record?.contenthash?.();
		return [value ? bytesLikeToHex(value) : "0x"];
	},
	async "name(bytes32)"(record) {
		return [(await record?.name?.()) || ""];
	},
	async "pubkey(bytes32)"(record) {
		const value = await record?.pubkey?.();
		if (isBytesLike(value)) return value;
		return value ? [value.x, value.y] : [0n, 0n];
	},
	async "ABI(bytes32,uint256)"(record, [, contentTypes], { history }) {
		if (history) history.show = [formatContentTypes(contentTypes)];
		const value = await record?.ABI?.(contentTypes);
		if (isBytesLike(value)) return value;
		return value ? [value.type, bytesLikeToHex(value.data)] : [0n, "0x"];
	},
	// not implemented:
	// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/resolvers/profiles/IInterfaceResolver.sol
	// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/resolvers/profiles/IDNSRecordResolver.sol
	// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/resolvers/profiles/IDNSZoneResolver.sol
	// https://github.com/ensdomains/ens-contracts/blob/staging/contracts/resolvers/profiles/IVersionableResolver.sol
};

const PROFILES = new Map(
	RESOLVE_ABI.flatMap((item) => {
		if (item.type !== "function") return [];
		const answer = ANSWERS[toFunctionSignature(item)];
		return answer ? [[toFunctionSelector(item), { abiFunction: item, answer }] as const] : [];
	}),
);

function formatContentTypes(contentTypes: bigint) {
	const v: string[] = [];
	if (contentTypes & 1n) v.push("JSON");
	if (contentTypes & 2n) v.push("zip(JSON)");
	if (contentTypes & 4n) v.push("CBOR");
	if (contentTypes & 8n) v.push("URI");
	return v.join("|");
}

/** Looks up the record for a name. Return nothing if the name does not exist. */
export type GetRecord<extra = undefined> = (name: string, ctx: CallContext<extra>) => Maybe<ENSRecord>;

export type ENSIP10Options = Omit<ProcessENSIP10Options, "history"> & {
	/** Answer unknown names with empty records instead of `UnreachableName`. (default: false) */
	unreachableAsEmpty?: boolean;
};

/**
 * Creates a handler for [ENSIP-10](https://docs.ens.domains/ensip/10) `resolve(bytes name, bytes data)`.
 * Note: the name is not normalized.
 */
export function createENSIP10Handler<extra = undefined>(
	getRecord: GetRecord<extra>,
	{ unreachableAsEmpty, ...options }: ENSIP10Options = {},
): HandlerFunction<typeof RESOLVE, extra> {
	return async ([dnsname, data], ctx) => {
		const name = dnsDecode(dnsname).join(".");
		ctx.history.show = [name];
		const record = await getRecord(name, ctx);
		if (!record && !unreachableAsEmpty) {
			ctx.history.error = "UnreachableName";
			return encodeErrorResult({ abi: [UNREACHABLE_NAME], args: [dnsname] });
		}
		// already encoded since: abi.decode(abi.encode(x)) == x
		return processENSIP10(record, data, { ...options, history: ctx.history.addInner() });
	};
}
