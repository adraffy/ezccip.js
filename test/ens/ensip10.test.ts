import { describe, expect, test } from "bun:test";
import {
	type AbiFunction,
	bytesToHex,
	decodeFunctionResult,
	encodeAbiParameters,
	encodeErrorResult,
	encodeFunctionData,
	type Hex,
	pad,
	parseAbiItem,
	parseAbiParameters,
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
	const cases: [string, Hex | Uint8Array | null | undefined][] = [
		["Uint8Array(0)", v.subarray(0, 0)],
		["Uint8Array(19)", v.subarray(0, 19)],
		["Uint8Array(20)", v.subarray(0, 20)],
		["Uint8Array(21)", v.subarray(0, 21)],
		["Uint8Array(63)", v],
		["hex(0)", "0x"],
		["hex(19)", bytesToHex(v.subarray(0, 19))],
		["hex(20)", bytesToHex(v.subarray(0, 20))],
		["hex(21)", bytesToHex(v.subarray(0, 21))],
		["null", null],
		["undefined", undefined],
	];
	const calldata = encodeFunctionData({ abi: [addr], args: [NODE] });
	for (const [label, value] of cases) {
		test(label, async () => {
			const encoded = await processENSIP10({ addr: () => value }, calldata);
			const hex = value ? (typeof value === "string" ? value : bytesToHex(value)).slice(2) : "";
			// truncated to 20 bytes, left-padded
			expect(encoded).toBe(`0x${hex.slice(0, 40).padStart(64, "0")}`);
		});
	}
});

describe("addr() => bytes", () => {
	const cases: [string, Hex | Uint8Array | null | undefined][] = [
		["Uint8Array(0)", new Uint8Array(0)],
		["Uint8Array", crypto.getRandomValues(new Uint8Array(63))],
		["empty hex", "0x"],
		["hex", "0x12"],
		["null", null],
		["undefined", undefined],
	];
	const calldata = encodeFunctionData({ abi: [addrCoin], args: [NODE, 0n] });
	for (const [label, value] of cases) {
		test(label, async () => {
			const encoded = await processENSIP10({ addr: () => value }, calldata);
			const hex = !value ? "0x" : typeof value === "string" ? value : bytesToHex(value);
			expect(encoded).toBe(encodeAbiParameters(parseAbiParameters("bytes"), [hex]));
		});
	}
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
});

describe("profiles", () => {
	const record: ENSRecord = {
		addr: (coinType) => (coinType === COIN_TYPE_ETH ? "0x1234" : undefined),
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

describe("throwErrors", () => {
	const selector = "0x12345678";
	test("false (default)", async () => {
		expect(await processENSIP10(undefined, selector)).toBe(
			encodeErrorResult({ abi: [UNSUPPORTED_RESOLVER_PROFILE], args: [selector] }),
		);
	});
	test("true", async () => {
		expect(processENSIP10(undefined, selector, { throwErrors: true })).rejects.toThrow();
	});
});
