import { describe, expect, test } from "bun:test";
import {
	type AbiFunction,
	bytesToHex,
	decodeFunctionResult,
	encodeErrorResult,
	encodeFunctionData,
	type Hex,
	pad,
	parseAbiItem,
	toFunctionSelector,
} from "viem";
import {
	COIN_TYPE_DEFAULT,
	COIN_TYPE_ETH,
	type ENSRecord,
	History,
	processENSIP10,
	UNSUPPORTED_RESOLVER_PROFILE,
} from "../../src/index.js";

const NODE = pad("0x");

const addr = parseAbiItem("function addr(bytes32) returns (address)");
const addrCoin = parseAbiItem("function addr(bytes32, uint256) returns (bytes)");
const hasAddr = parseAbiItem("function hasAddr(bytes32, uint256) returns (bool)");
const text = parseAbiItem("function text(bytes32, string) returns (string)");
const data = parseAbiItem("function data(bytes32, string) returns (bytes)");
const contenthash = parseAbiItem("function contenthash(bytes32) returns (bytes)");
const name = parseAbiItem("function name(bytes32) returns (string)");
const pubkey = parseAbiItem("function pubkey(bytes32) returns (uint256, uint256)");
const ABI = parseAbiItem("function ABI(bytes32, uint256) returns (uint256, bytes)");
const multicall = parseAbiItem("function multicall(bytes[]) returns (bytes[])");

/** Encodes a call, answers it from a record, and decodes the result. */
async function query<const fn extends AbiFunction>(
	record: ENSRecord | undefined,
	abiFunction: fn,
	args: readonly unknown[],
	options?: Parameters<typeof processENSIP10>[2],
) {
	const calldata = encodeFunctionData({ abi: [abiFunction as AbiFunction], args } as never);
	const result = await processENSIP10(record, calldata, options);
	return decodeFunctionResult({ abi: [abiFunction as AbiFunction], data: result }) as unknown;
}

describe("addr() => address", () => {
	const v = crypto.getRandomValues(new Uint8Array(63));
	const calldata = encodeFunctionData({ abi: [addr], args: [NODE] });
	const answer = (value: Hex | Uint8Array | null | undefined) => processENSIP10({ addr: () => value }, calldata);
	const zero = pad("0x");
	for (const [label, value] of [
		["null", null],
		["undefined", undefined],
		["hex(0)", "0x"],
		["Uint8Array(0)", v.subarray(0, 0)],
	] as const) {
		test(`${label} => zero`, async () => expect(await answer(value)).toBe(zero));
	}
	test("hex(20)", async () =>
		expect(await answer(bytesToHex(v.subarray(0, 20)))).toBe(pad(bytesToHex(v.subarray(0, 20)))));
	test("Uint8Array(20)", async () => expect(await answer(v.subarray(0, 20))).toBe(pad(bytesToHex(v.subarray(0, 20)))));
	for (const n of [1, 19, 21, 32, 63]) {
		test(`${n} bytes => throws`, async () => {
			expect(answer(v.subarray(0, n))).rejects.toThrow(`expected 20 bytes, got ${n}`);
		});
	}
});

describe("addr(coinType)", () => {
	const v = crypto.getRandomValues(new Uint8Array(32));
	const answer = (coinType: bigint, value: Hex | Uint8Array | null | undefined) =>
		query({ addr: () => value }, addrCoin, [NODE, coinType]);
	const evm = [60n, COIN_TYPE_DEFAULT, COIN_TYPE_DEFAULT | 10n];
	for (const coinType of evm) {
		test(`evm ${coinType}: 20 bytes`, async () => {
			expect(await answer(coinType, v.subarray(0, 20))).toBe(bytesToHex(v.subarray(0, 20)));
		});
		test(`evm ${coinType}: other sizes throw`, async () => {
			expect(answer(coinType, v.subarray(0, 21))).rejects.toThrow("expected 20 bytes");
			expect(answer(coinType, v)).rejects.toThrow("expected 20 bytes");
		});
	}
	test("non-evm: any bytes", async () => {
		expect(await answer(0n, v)).toBe(bytesToHex(v)); // bitcoin
		expect(await answer(3n, v.subarray(0, 5))).toBe(bytesToHex(v.subarray(0, 5)));
	});
	for (const value of [null, undefined, "0x", new Uint8Array(0)] as const) {
		test(`empty: ${String(value)}`, async () => expect(await answer(0n, value)).toBe("0x"));
	}
});

describe("hasAddr", () => {
	const answer = (value: Hex | Uint8Array | null | undefined) => query({ addr: () => value }, hasAddr, [NODE, 0n]);
	test("empty => false", async () => {
		for (const value of [null, undefined, "0x", new Uint8Array(0)] as const) {
			expect(await answer(value)).toBe(false);
		}
	});
	test("value => true", async () => expect(await answer("0x12")).toBe(true));
});

describe("default address", () => {
	const DEFAULT = "0x51050ec063d393217b436747617ad1c2285aeeee";
	const record: ENSRecord = {
		addr: (coinType) => (coinType === COIN_TYPE_DEFAULT ? DEFAULT : undefined),
	};
	test("addr(bytes32)", async () => {
		expect(String(await query(record, addr, [NODE])).toLowerCase()).toBe(DEFAULT);
	});
	test("evm coin type", async () => {
		expect(await query(record, addrCoin, [NODE, COIN_TYPE_DEFAULT | 10n])).toBe(DEFAULT);
	});
	test("non-evm coin type", async () => {
		expect(await query(record, addrCoin, [NODE, 0n])).toBe("0x");
	});
	test("disabled", async () => {
		expect(await query(record, addr, [NODE], { defaultAddress: false })).toBe(`0x${"0".repeat(40)}`);
	});
	test("empty bytes fall back", async () => {
		const empty: ENSRecord = { addr: (coinType) => (coinType === COIN_TYPE_DEFAULT ? DEFAULT : "0x") };
		expect(await query(empty, addrCoin, [NODE, COIN_TYPE_DEFAULT | 10n])).toBe(DEFAULT);
	});
});

describe("profiles", () => {
	const record: ENSRecord = {
		addr: (coinType) => (coinType === COIN_TYPE_ETH ? "0x51050ec063d393217b436747617ad1c2285aeeee" : undefined),
		text: (key) => (key === "name" ? "Raffy" : undefined),
		data: (key) => (key === "test" ? Uint8Array.of(1, 2, 3) : undefined),
		contenthash: () => "0xe301",
		name: () => "raffy.eth",
		pubkey: () => ({ x: 1, y: 2n }),
		ABI: (contentTypes) => (contentTypes & 1n ? { type: 1n, data: "0x7b7d" } : undefined),
	};
	test("text", async () => expect(await query(record, text, [NODE, "name"])).toBe("Raffy"));
	test("text (missing)", async () => expect(await query(record, text, [NODE, "x"])).toBe(""));
	test("hasAddr", async () => {
		expect(await query(record, hasAddr, [NODE, 60n])).toBe(true);
		expect(await query(record, hasAddr, [NODE, 0n])).toBe(false);
	});
	test("data", async () => expect(await query(record, data, [NODE, "test"])).toBe("0x010203"));
	test("contenthash", async () => expect(await query(record, contenthash, [NODE])).toBe("0xe301"));
	test("name", async () => expect(await query(record, name, [NODE])).toBe("raffy.eth"));
	test("pubkey", async () => expect(await query(record, pubkey, [NODE])).toEqual([1n, 2n]));
	test("pubkey (encoded)", async () => {
		const encoded = pad("0x", { size: 64 });
		const calldata = encodeFunctionData({ abi: [pubkey], args: [NODE] });
		expect(await processENSIP10({ pubkey: () => encoded }, calldata)).toBe(encoded);
	});
	test("ABI", async () => {
		expect(await query(record, ABI, [NODE, 1n])).toEqual([1n, "0x7b7d"]);
		expect(await query(record, ABI, [NODE, 2n])).toEqual([0n, "0x"]);
	});
	test("no record", async () => expect(await query(undefined, text, [NODE, "name"])).toBe(""));
	test("multicall", async () => {
		const history = new History();
		const calls = [
			encodeFunctionData({ abi: [text], args: [NODE, "name"] }),
			encodeFunctionData({ abi: [name], args: [NODE] }),
		];
		const [a, b] = (await query(record, multicall, [calls], { history })) as Hex[];
		expect(decodeFunctionResult({ abi: [text], data: a! })).toBe("Raffy");
		expect(decodeFunctionResult({ abi: [name], data: b! })).toBe("raffy.eth");
		expect(String(history)).toBe("multicall()^2 [text(name) name()]");
	});
	test("multicall subcall cannot be multicall", async () => {
		const nested = encodeFunctionData({ abi: [multicall], args: [[]] });
		const [result] = (await query(record, multicall, [[nested]])) as Hex[];
		expect(result).toBe(
			encodeErrorResult({ abi: [UNSUPPORTED_RESOLVER_PROFILE], args: [toFunctionSelector(multicall)] }),
		);
	});
	test("multicall disabled", async () => {
		const calldata = encodeFunctionData({ abi: [multicall], args: [[]] });
		const result = await processENSIP10(record, calldata, { multicall: false });
		expect(result).toBe(
			encodeErrorResult({ abi: [UNSUPPORTED_RESOLVER_PROFILE], args: [toFunctionSelector(multicall)] }),
		);
	});
});

describe("throwUnsupported", () => {
	const selector = "0x12345678";
	test("false (default)", async () => {
		expect(await processENSIP10(undefined, selector)).toBe(
			encodeErrorResult({ abi: [UNSUPPORTED_RESOLVER_PROFILE], args: [selector] }),
		);
	});
	test("true", async () => {
		expect(processENSIP10(undefined, selector, { throwUnsupported: true })).rejects.toMatchObject({ status: 404 });
	});
});
