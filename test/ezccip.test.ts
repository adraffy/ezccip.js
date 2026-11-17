import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	type AbiFunction,
	type Address,
	bytesToHex,
	decodeAbiParameters,
	decodeErrorResult,
	decodeFunctionResult,
	encodeAbiParameters,
	encodeErrorResult,
	encodeFunctionData,
	getAbiItem,
	getAddress,
	type Hex,
	numberToBytes,
	pad,
	parseAbi,
	parseAbiItem,
	parseAbiParameters,
	toFunctionSelector,
} from "viem";
import { packetToBytes } from "viem/ens";
import { EZCCIP, type FunctionHandler, type History, MULTICALL, RESOLVE, UNREACHABLE_NAME } from "../src/index.js";

const sender = getAddress("0x0000000000000000000000000000000000000001");
const SOLIDITY_ERROR = parseAbiItem("error Error(string)");

function encode(abiFunction: AbiFunction, args: readonly unknown[] = []) {
	return encodeFunctionData({ abi: [abiFunction], args } as never);
}

/** Calls a function through `handleRead` and returns the decoded outputs as an array. */
async function call(ezccip: EZCCIP, abiFunction: AbiFunction, args: readonly unknown[] = []) {
	const { data } = await ezccip.handleRead({ sender, data: encode(abiFunction, args), protocol: "raw" });
	return decodeAbiParameters(abiFunction.outputs, data) as readonly unknown[];
}

describe("register", () => {
	test("signature", async () => {
		const ezccip = new EZCCIP();
		const fn = ezccip.register("function plus(uint256 a, uint256 b) returns (uint256 c)", (args, context, history) => {
			expectTypeOf(args).toEqualTypeOf<readonly [bigint, bigint]>();
			expectTypeOf(context.sender).toEqualTypeOf<Address>();
			expectTypeOf(history).toEqualTypeOf<History>();
			const [a, b] = args;
			return [a + b];
		});
		expect(fn.signature).toBe("plus(uint256,uint256)");
		expect(fn.selector).toBe(toFunctionSelector("function plus(uint256,uint256)"));
		expect(await call(ezccip, fn.abiFunction, [1n, 2n])).toEqual([3n]);
	});

	test("without function prefix", async () => {
		const ezccip = new EZCCIP();
		const fn = ezccip.register("f(string x) returns (string)", ([x]) => {
			expectTypeOf(x).toEqualTypeOf<string>();
			return [x.toUpperCase()];
		});
		expect(await call(ezccip, fn.abiFunction, ["abc"])).toEqual(["ABC"]);
	});

	test("AbiFunction", async () => {
		const ezccip = new EZCCIP();
		const fn = parseAbiItem("function f(bytes32 x) returns (string)");
		ezccip.register(fn, ([x]) => {
			expectTypeOf(x).toEqualTypeOf<Hex>();
			return [x];
		});
		const x = pad("0x01");
		expect(await call(ezccip, fn, [x])).toEqual([x]);
	});

	test("from an ABI", async () => {
		const ezccip = new EZCCIP();
		const abi = parseAbi([
			"function f(uint256 x) returns (uint256)",
			"function f(string s) returns (string)",
			"function g((uint256 a, bool b)[] s) returns (bool)",
		]);
		const [fUint, fString, g] = abi;
		ezccip.register(fUint, ([x]) => [x * 2n]);
		ezccip.register(fString, ([s]) => [`${s}!`]);
		ezccip.register(getAbiItem({ abi, name: "g" }), ([s]) => {
			expectTypeOf(s).toEqualTypeOf<readonly { a: bigint; b: boolean }[]>();
			return [s.some((x) => x.b)];
		});
		expect(await call(ezccip, fUint, [21n])).toEqual([42n]);
		expect(await call(ezccip, fString, ["hi"])).toEqual(["hi!"]);
		expect(await call(ezccip, g, [[{ a: 1n, b: true }]])).toEqual([true]);
	});

	test("typed result", () => {
		const ezccip = new EZCCIP();
		// @ts-expect-error wrong output type
		ezccip.register("function f() returns (uint256)", () => ["x"]);
		// @ts-expect-error wrong arity
		ezccip.register("function f() returns (uint256)", () => [1n, 2n]);
	});

	test("replace", async () => {
		const ezccip = new EZCCIP();
		const fn = parseAbiItem("function f() returns (uint256)");
		ezccip.register(fn, () => [1n]);
		ezccip.register(fn, () => [2n]);
		expect(await call(ezccip, fn)).toEqual([2n]);
	});

	test("not a function", () => {
		const ezccip = new EZCCIP();
		expect(() => ezccip.register(parseAbiItem("event E()") as never, () => {})).toThrow();
	});
});

test("getFunction", () => {
	const ezccip = new EZCCIP();
	const fn = parseAbiItem("function g(uint256 a, uint256 b) view returns (uint256)");
	ezccip.register(fn, () => [0n]);
	const selector = toFunctionSelector(fn);
	expect(ezccip.getFunction("g")?.selector).toBe(selector);
	expect(ezccip.getFunction("g(uint256,uint256)")?.selector).toBe(selector);
	expect(ezccip.getFunction(selector)?.selector).toBe(selector);
	expect(ezccip.getFunction(fn)?.selector).toBe(selector);
	expect(ezccip.getFunction("multicall")).toBeDefined();
	expect(ezccip.getFunction("nope")).toBeUndefined();
	expect(ezccip.functions.map((x) => x.signature)).toEqual(["multicall(bytes[])", "g(uint256,uint256)"]);
});

describe("results", () => {
	const fn = parseAbiItem("function f(uint256) returns (uint256)");
	const cases: Record<string, FunctionHandler<typeof fn>> = {
		tuple: ([x]) => [x],
		hex: ([x]) => encodeAbiParameters(parseAbiParameters("uint256"), [x]),
		bytes: ([x]) => numberToBytes(x, { size: 32 }),
		async: async ([x]) => [x],
	};
	for (const [label, handler] of Object.entries(cases)) {
		test(label, async () => {
			const ezccip = new EZCCIP();
			ezccip.register(fn, handler);
			expect(await call(ezccip, fn, [1337n])).toEqual([1337n]);
		});
	}
	test("void", async () => {
		const ezccip = new EZCCIP();
		const g = parseAbiItem("function g()");
		ezccip.register(g, () => {});
		const { data } = await ezccip.handleRead({ sender, data: encode(g) });
		expect(data).toBe("0x");
	});
});

describe("handleRead", () => {
	test("context", async () => {
		const ezccip = new EZCCIP({ ttl: 5 });
		const fn = parseAbiItem("function f() returns (address, address)");
		ezccip.register(fn, (_, context, history) => {
			expect(context.calldata).toBe(history.calldata!);
			expect(context.ttl).toBe(5);
			expect(context.protocol).toBe("raw");
			expect(context.signer).toBeUndefined();
			return [context.sender, context.origin];
		});
		const origin = "0x0000000000000000000000000000000000000002";
		const res = await ezccip.handleRead({ sender: sender.toLowerCase() as Hex, data: encode(fn), origin });
		expect(res.context.sender).toBe(sender);
		expect(decodeFunctionResult({ abi: [fn], data: res.data })).toEqual([sender, origin]);
	});

	test("extra context", async () => {
		const ezccip = new EZCCIP<{ env: { greeting: string } }>();
		const fn = ezccip.register("f() returns (string)", (_, context) => [context.env.greeting]);
		const { data } = await ezccip.handleRead({
			sender,
			data: fn.selector,
			extra: { env: { greeting: "hello" } },
		});
		expect(decodeFunctionResult({ abi: [fn.abiFunction], data })).toBe("hello");
	});

	test("invalid input", async () => {
		const ezccip = new EZCCIP();
		expect(ezccip.handleRead({ sender: "0x1234", data: "0x12345678" })).rejects.toMatchObject({ status: 400 });
		expect(ezccip.handleRead({ sender, data: "0x1234" })).rejects.toMatchObject({ status: 400 });
		expect(ezccip.handleRead({ sender, data: "0x12345678" })).rejects.toThrow("unsupported ccip method");
	});

	test("history", async () => {
		const ezccip = new EZCCIP();
		const fn = ezccip.register("f(string s, uint256 x) returns (uint256)", (_, __, history) => {
			history.show = ["custom"];
			history.name = "Chonk";
			return [0n];
		});
		const { history } = await ezccip.handleRead({ sender, data: encode(fn.abiFunction, ["a", 1n]) });
		expect(String(history)).toBe("Chonk(custom)");
	});
});

describe("multicall", () => {
	const f = parseAbiItem("function f(uint256 x) returns (uint256)");
	const fail = parseAbiItem("function fail()");
	function make(recursionLimit?: number) {
		const ezccip = new EZCCIP({ recursionLimit });
		ezccip.register(f, ([x]) => [x * 2n]);
		ezccip.register(fail, () => {
			throw new Error("nope");
		});
		return ezccip;
	}
	const multicall = (calls: Hex[]) => encode(MULTICALL, [calls]);
	const results = (data: Hex) => decodeFunctionResult({ abi: [MULTICALL], data });

	test("calls + errors", async () => {
		const res = await make().handleRead({ sender, data: multicall([encode(f, [1n]), encode(fail)]) });
		const [a, b] = results(res.data);
		expect(decodeFunctionResult({ abi: [f], data: a! })).toBe(2n);
		expect(decodeErrorResult({ abi: [SOLIDITY_ERROR], data: b! }).args).toEqual(["nope"]);
		expect(String(res.history)).toBe("multicall()^2 [f(1) fail()<nope>]");
	});

	test("nested", async () => {
		const res = await make(2).handleRead({ sender, data: multicall([multicall([encode(f, [3n])])]) });
		const [inner] = results(res.data);
		const [a] = results(inner!);
		expect(decodeFunctionResult({ abi: [f], data: a! })).toBe(6n);
	});

	test("recursion limit", async () => {
		const res = await make(1).handleRead({ sender, data: multicall([multicall([encode(f, [3n])])]) });
		const [inner] = results(res.data);
		const [message] = decodeErrorResult({ abi: [SOLIDITY_ERROR], data: inner! }).args;
		expect(message).toContain("unsupported ccip method");
	});

	test("disabled", async () => {
		expect(make(0).handleRead({ sender, data: multicall([]) })).rejects.toThrow("unsupported ccip method");
	});
});

describe("enableENSIP10", () => {
	const text = parseAbiItem("function text(bytes32, string) returns (string)");
	const inner = encode(text, [pad("0x"), "name"]);
	const resolve = (name: Hex) => encode(RESOLVE, [name, inner]);

	test("resolve", async () => {
		const ezccip = new EZCCIP();
		ezccip.enableENSIP10((name) => ({ text: (key) => `${name}:${key}` }));
		const res = await ezccip.handleRead({ sender, data: resolve(bytesToHex(packetToBytes("raffy.eth"))) });
		expect(decodeFunctionResult({ abi: [text], data: res.data })).toBe("raffy.eth:name");
		expect(String(res.history)).toBe("resolve(raffy.eth).text(name)");
	});

	test("unreachable (default)", async () => {
		const ezccip = new EZCCIP();
		ezccip.enableENSIP10(() => undefined);
		const res = await ezccip.handleRead({ sender, data: resolve("0x00") });
		expect(res.data).toBe(encodeErrorResult({ abi: [UNREACHABLE_NAME], args: ["0x00"] }));
	});

	test("unreachableAsEmpty", async () => {
		const ezccip = new EZCCIP();
		ezccip.enableENSIP10(() => undefined, { unreachableAsEmpty: true });
		const res = await ezccip.handleRead({ sender, data: resolve("0x00") });
		expect(decodeFunctionResult({ abi: [text], data: res.data })).toBe("");
	});
});
