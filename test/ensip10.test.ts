import { describe, expect, test } from "bun:test";
import { AbiError, AbiFunction, AbiParameters, Bytes, Hex } from "ox";
import {
	COIN_TYPE_DEFAULT,
	COIN_TYPE_ETH,
	type ENSRecord,
	History,
	processENSIP10,
	RESOLVE_ABI,
} from "../src/index.ts";

const NODE = Hex.padLeft("0x", 32);

const addr = AbiFunction.from("function addr(bytes32) returns (address)");
const addrCoin = AbiFunction.from("function addr(bytes32, uint256) returns (bytes)");
const hasAddr = AbiFunction.from("function hasAddr(bytes32, uint256) returns (bool)");
const text = AbiFunction.from("function text(bytes32, string) returns (string)");
const data = AbiFunction.from("function data(bytes32, string) returns (bytes)");
const contenthash = AbiFunction.from("function contenthash(bytes32) returns (bytes)");
const name = AbiFunction.from("function name(bytes32) returns (string)");
const pubkey = AbiFunction.from("function pubkey(bytes32) returns (uint256, uint256)");
const ABI = AbiFunction.from("function ABI(bytes32, uint256) returns (uint256, bytes)");
const multicall = AbiFunction.from("function multicall(bytes[]) returns (bytes[])");

describe("addr() => address", () => {
	const call = AbiFunction.encodeData(addr, [NODE]);
	const v = Bytes.random(63);
	const cases: [string, Hex.Hex | Uint8Array | undefined | null][] = [
		["Uint8Array(0)", v.subarray(0, 0)],
		["Uint8Array(19)", v.subarray(0, 19)],
		["Uint8Array(20)", v.subarray(0, 20)],
		["Uint8Array(21)", v.subarray(0, 21)],
		["Uint8Array(63)", v],
		["hex(0)", "0x"],
		["hex(19)", Hex.fromBytes(v.subarray(0, 19))],
		["hex(20)", Hex.fromBytes(v.subarray(0, 20))],
		["hex(21)", Hex.fromBytes(v.subarray(0, 21))],
		["null", null],
		["undefined", undefined],
	];
	for (const [label, value] of cases) {
		test(label, async () => {
			const encoded = await processENSIP10({ addr: () => value }, call);
			const hex = value ? Hex.from(value).slice(2) : "";
			expect(encoded).toBe(`0x${hex.slice(0, 40).padStart(64, "0")}`);
		});
	}
});

describe("addr() => bytes", () => {
	const call = AbiFunction.encodeData(addrCoin, [NODE, 0n]);
	const cases: [string, Hex.Hex | Uint8Array | undefined | null][] = [
		["Uint8Array(0)", new Uint8Array(0)],
		["Uint8Array", Bytes.random(63)],
		["null hex", "0x"],
		["hex", "0x12"],
		["null", null],
		["undefined", undefined],
	];
	for (const [label, value] of cases) {
		test(label, async () => {
			const encoded = await processENSIP10({ addr: () => value }, call);
			expect(encoded).toBe(
				AbiParameters.encode(AbiParameters.from(["bytes"]), [value ? Hex.from(value) : "0x"])
			);
		});
	}
});

describe("default address", () => {
	const DEFAULT = "0x51050ec063d393217b436747617ad1c2285aeeee";
	const record: ENSRecord = {
		addr: (type) => (type === COIN_TYPE_DEFAULT ? DEFAULT : undefined),
	};
	test("addr(bytes32)", async () => {
		const res = await processENSIP10(record, AbiFunction.encodeData(addr, [NODE]));
		expect(AbiFunction.decodeResult(addr, res).toLowerCase()).toBe(DEFAULT);
	});
	test("evm coin type", async () => {
		const res = await processENSIP10(
			record,
			AbiFunction.encodeData(addrCoin, [NODE, COIN_TYPE_DEFAULT | 10n])
		);
		expect(AbiFunction.decodeResult(addrCoin, res)).toBe(DEFAULT);
	});
	test("non-evm coin type", async () => {
		const res = await processENSIP10(record, AbiFunction.encodeData(addrCoin, [NODE, 0n]));
		expect(AbiFunction.decodeResult(addrCoin, res)).toBe("0x");
	});
	test("disabled", async () => {
		const res = await processENSIP10(record, AbiFunction.encodeData(addr, [NODE]), {
			defaultAddress: false,
		});
		expect(AbiFunction.decodeResult(addr, res)).toBe(`0x${"0".repeat(40)}`);
	});
});

describe("profiles", () => {
	const record: ENSRecord = {
		addr: (type) => (type === COIN_TYPE_ETH ? "0x1234" : undefined),
		text: (key) => (key === "name" ? "Raffy" : undefined),
		data: (key) => (key === "test" ? Uint8Array.of(1, 2, 3) : undefined),
		contenthash: () => "0xe301",
		name: () => "raffy.eth",
		pubkey: () => ({ x: 1, y: 2n }),
		ABI: (types) => (types & 1 ? { type: 1, data: "0x7b7d" } : undefined),
	};
	test("text", async () => {
		const res = await processENSIP10(record, AbiFunction.encodeData(text, [NODE, "name"]));
		expect(AbiFunction.decodeResult(text, res)).toBe("Raffy");
	});
	test("text (missing)", async () => {
		const res = await processENSIP10(record, AbiFunction.encodeData(text, [NODE, "x"]));
		expect(AbiFunction.decodeResult(text, res)).toBe("");
	});
	test("hasAddr", async () => {
		const yes = await processENSIP10(record, AbiFunction.encodeData(hasAddr, [NODE, 60n]));
		const no = await processENSIP10(record, AbiFunction.encodeData(hasAddr, [NODE, 0n]));
		expect(AbiFunction.decodeResult(hasAddr, yes)).toBe(true);
		expect(AbiFunction.decodeResult(hasAddr, no)).toBe(false);
	});
	test("data", async () => {
		const res = await processENSIP10(record, AbiFunction.encodeData(data, [NODE, "test"]));
		expect(AbiFunction.decodeResult(data, res)).toBe("0x010203");
	});
	test("contenthash", async () => {
		const res = await processENSIP10(record, AbiFunction.encodeData(contenthash, [NODE]));
		expect(AbiFunction.decodeResult(contenthash, res)).toBe("0xe301");
	});
	test("name", async () => {
		const res = await processENSIP10(record, AbiFunction.encodeData(name, [NODE]));
		expect(AbiFunction.decodeResult(name, res)).toBe("raffy.eth");
	});
	test("pubkey", async () => {
		const res = await processENSIP10(record, AbiFunction.encodeData(pubkey, [NODE]));
		expect(AbiFunction.decodeResult(pubkey, res)).toEqual([1n, 2n]);
	});
	test("pubkey (raw)", async () => {
		const raw = Hex.padLeft("0x", 64);
		const res = await processENSIP10({ pubkey: () => raw }, AbiFunction.encodeData(pubkey, [NODE]));
		expect(res).toBe(raw);
	});
	test("ABI", async () => {
		const res = await processENSIP10(record, AbiFunction.encodeData(ABI, [NODE, 1n]));
		expect(AbiFunction.decodeResult(ABI, res)).toEqual([1n, "0x7b7d"]);
		const empty = await processENSIP10(record, AbiFunction.encodeData(ABI, [NODE, 2n]));
		expect(AbiFunction.decodeResult(ABI, empty)).toEqual([0n, "0x"]);
	});
	test("no record", async () => {
		const res = await processENSIP10(undefined, AbiFunction.encodeData(text, [NODE, "name"]));
		expect(AbiFunction.decodeResult(text, res)).toBe("");
	});
	test("multicall", async () => {
		const history = new History(1);
		const res = await processENSIP10(
			record,
			AbiFunction.encodeData(multicall, [
				[
					AbiFunction.encodeData(text, [NODE, "name"]),
					AbiFunction.encodeData(name, [NODE]),
				],
			]),
			{ history }
		);
		const [a, b] = AbiFunction.decodeResult(multicall, res);
		expect(AbiFunction.decodeResult(text, a!)).toBe("Raffy");
		expect(AbiFunction.decodeResult(name, b!)).toBe("raffy.eth");
		expect(String(history)).toBe("multicall()^2 [text(name) name()]");
	});
	test("multicall disabled", async () => {
		const call = AbiFunction.encodeData(multicall, [[]]);
		const res = await processENSIP10(record, call, { multicall: false });
		expect(res.startsWith(AbiError.getSelector(AbiError.fromAbi(RESOLVE_ABI, "UnsupportedResolverProfile")))).toBe(true);
	});
});

describe("throwErrors", () => {
	const selector = "0x12345678";
	test("false (default)", async () => {
		expect(await processENSIP10(undefined, selector)).toBe(
			AbiError.encode(AbiError.fromAbi(RESOLVE_ABI, "UnsupportedResolverProfile"), [selector])
		);
	});
	test("true", async () => {
		expect(processENSIP10(undefined, selector, { throwErrors: true })).rejects.toThrow();
	});
});
