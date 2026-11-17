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
import { generatePrivateKey } from "viem/accounts";
import { packetToBytes } from "viem/ens";
import { MULTICALL, RESOLVE, UNREACHABLE_NAME } from "../src/ens/abi.js";
import { type CallContext, CCIPReadError, EZCCIP, type HandlerFunction } from "../src/index.js";

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

describe("addHandler", () => {
	test("signature", async () => {
		const ezccip = new EZCCIP();
		const handler = ezccip.addHandler("function plus(uint256 a, uint256 b) returns (uint256 c)", (args, ctx, extra) => {
			expectTypeOf(args).toEqualTypeOf<readonly [bigint, bigint]>();
			expectTypeOf(ctx).toEqualTypeOf<CallContext>();
			expectTypeOf(extra).toEqualTypeOf<undefined>();
			expectTypeOf(ctx.sender).toEqualTypeOf<Address>();
			const [a, b] = args;
			return [a + b];
		});
		expect(handler.signature).toBe("plus(uint256,uint256)");
		expect(handler.selector).toBe(toFunctionSelector("function plus(uint256,uint256)"));
		expect(await call(ezccip, handler.abiFunction, [1n, 2n])).toEqual([3n]);
	});

	test("without function prefix", async () => {
		const ezccip = new EZCCIP();
		const handler = ezccip.addHandler("f(string x) returns (string)", ([x]) => {
			expectTypeOf(x).toEqualTypeOf<string>();
			return [x.toUpperCase()];
		});
		expect(await call(ezccip, handler.abiFunction, ["abc"])).toEqual(["ABC"]);
	});

	test("AbiFunction", async () => {
		const ezccip = new EZCCIP();
		const fn = parseAbiItem("function f(bytes32 x) returns (string)");
		ezccip.addHandler(fn, ([x]) => {
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
		ezccip.addHandler(fUint, ([x]) => [x * 2n]);
		ezccip.addHandler(fString, ([s]) => [`${s}!`]);
		ezccip.addHandler(getAbiItem({ abi, name: "g" }), ([s]) => {
			expectTypeOf(s).toEqualTypeOf<readonly { a: bigint; b: boolean }[]>();
			return [s.some((x) => x.b)];
		});
		expect(await call(ezccip, fUint, [21n])).toEqual([42n]);
		expect(await call(ezccip, fString, ["hi"])).toEqual(["hi!"]);
		expect(await call(ezccip, g, [[{ a: 1n, b: true }]])).toEqual([true]);
	});

	test("prefix needs a space", async () => {
		const ezccip = new EZCCIP();
		const handler = ezccip.addHandler("functionality() returns (uint256)", () => [1n]);
		expect(handler.signature).toBe("functionality()");
		expect(await call(ezccip, handler.abiFunction)).toEqual([1n]);
	});

	test("typed result", () => {
		const ezccip = new EZCCIP();
		// @ts-expect-error returning nothing requires no outputs
		ezccip.addHandler("function f() returns (uint256)", () => {});
		// @ts-expect-error wrong output type
		ezccip.addHandler("function f() returns (uint256)", () => ["x"]);
		// @ts-expect-error wrong arity
		ezccip.addHandler("function f() returns (uint256)", () => [1n, 2n]);
	});

	test("replace", async () => {
		const ezccip = new EZCCIP();
		const fn = parseAbiItem("function f() returns (uint256)");
		ezccip.addHandler(fn, () => [1n]);
		ezccip.addHandler(fn, () => [2n]);
		expect(await call(ezccip, fn)).toEqual([2n]);
	});

	test("not a function", () => {
		const ezccip = new EZCCIP();
		expect(() => ezccip.addHandler(parseAbiItem("event E()") as never, () => {})).toThrow();
	});
});

test("findHandler", () => {
	const ezccip = new EZCCIP();
	const fn = parseAbiItem("function g(uint256 a, uint256 b) view returns (uint256)");
	ezccip.addHandler(fn, () => [0n]);
	const selector = toFunctionSelector(fn);
	expect(ezccip.findHandler("g")?.selector).toBe(selector);
	expect(ezccip.findHandler("g(uint256,uint256)")?.selector).toBe(selector);
	expect(ezccip.findHandler(selector)?.selector).toBe(selector);
	expect(ezccip.findHandler(fn)?.selector).toBe(selector);
	expect(ezccip.findHandler("nope")).toBeUndefined();
	// multicall is built in, not a handler
	expect(ezccip.findHandler("multicall")).toBeUndefined();
	expect(ezccip.handlers.map((x) => x.signature)).toEqual(["g(uint256,uint256)"]);
	expect(() => ezccip.addHandler(MULTICALL, () => [[]])).toThrow("multicall is built in");
});

describe("results", () => {
	const fn = parseAbiItem("function f(uint256) returns (uint256)");
	const cases: Record<string, HandlerFunction<typeof fn>> = {
		tuple: ([x]) => [x],
		hex: ([x]) => encodeAbiParameters(parseAbiParameters("uint256"), [x]),
		bytes: ([x]) => numberToBytes(x, { size: 32 }),
		async: async ([x]) => [x],
	};
	for (const [label, fn_] of Object.entries(cases)) {
		test(label, async () => {
			const ezccip = new EZCCIP();
			ezccip.addHandler(fn, fn_);
			expect(await call(ezccip, fn, [1337n])).toEqual([1337n]);
		});
	}
	test("void", async () => {
		const ezccip = new EZCCIP();
		const g = parseAbiItem("function g()");
		ezccip.addHandler(g, () => {});
		const { data } = await ezccip.handleRead({ sender, data: encode(g) });
		expect(data).toBe("0x");
	});
});

describe("handleRead", () => {
	test("context", async () => {
		const ezccip = new EZCCIP({ ttl: 5 });
		const fn = parseAbiItem("function f() returns (address, address)");
		ezccip.addHandler(fn, (_, ctx) => {
			expect(ctx.calldata).toBe(encode(fn));
			expect(ctx.ttl).toBe(5);
			expect(ctx.protocol).toBe("raw");
			expect(ctx.signer).toBeUndefined();
			return [ctx.sender, ctx.origin];
		});
		const origin = "0x0000000000000000000000000000000000000002";
		const res = await ezccip.handleRead({ sender: sender.toLowerCase() as Hex, data: encode(fn), origin });
		expect(res.context.sender).toBe(sender);
		expect(decodeFunctionResult({ abi: [fn], data: res.data })).toEqual([sender, origin]);
	});

	test("extra reaches multicall subcalls and resolve()", async () => {
		const ezccip = new EZCCIP<{ suffix: string }>();
		const text = parseAbiItem("function text(bytes32, string) returns (string)");
		const f = ezccip.addHandler("function f() returns (string)", (_, __, extra) => [`f${extra.suffix}`]);
		ezccip.enableENSIP10({ resolve: (name, _, extra) => ({ text: () => `${name}${extra.suffix}` }) });
		const resolve = encode(RESOLVE, [bytesToHex(packetToBytes("a.eth")), encode(text, [pad("0x"), "k"])]);
		const { data } = await ezccip.handleRead({
			sender,
			data: encode(MULTICALL, [[f.selector, resolve]]),
			extra: { suffix: "!" },
		});
		const [a, b] = decodeFunctionResult({ abi: [MULTICALL], data });
		expect(decodeFunctionResult({ abi: [f.abiFunction], data: a! })).toBe("f!");
		expect(decodeFunctionResult({ abi: [text], data: b! })).toBe("a.eth!");
	});

	test("extra", async () => {
		const ezccip = new EZCCIP<{ env: { greeting: string } }>();
		const handler = ezccip.addHandler("f() returns (string)", (_, __, extra) => [extra.env.greeting]);
		// @ts-expect-error extra is required
		() => ezccip.handleRead({ sender, data: handler.selector });
		const { data } = await ezccip.handleRead({ sender, data: handler.selector, extra: { env: { greeting: "hello" } } });
		expect(decodeFunctionResult({ abi: [handler.abiFunction], data })).toBe("hello");
	});

	test("origin option", async () => {
		const origin = "0x0000000000000000000000000000000000000002";
		const ezccip = new EZCCIP({ origin });
		const handler = ezccip.addHandler("function f() returns (address)", (_, ctx) => [ctx.origin]);
		const { context } = await ezccip.handleRead({ sender, data: handler.selector });
		expect(context.origin).toBe(origin);
		expect(() => new EZCCIP({ origin: "0x1234" })).toThrow("invalid origin");
	});

	test("validation", async () => {
		expect(() => new EZCCIP({ ttl: Number.NaN })).toThrow("invalid ttl");
		expect(() => new EZCCIP({ ttl: -1 })).toThrow("invalid ttl");
		const ezccip = new EZCCIP();
		const hex = ezccip.addHandler("function hex() returns (string)", (() => "hello") as never);
		const origin = ezccip.addHandler("function origin()", (_, ctx) => {
			ctx.origin = "0xbad";
		});
		const ttl = ezccip.addHandler("function ttl()", (_, ctx) => {
			ctx.ttl = -1;
		});
		expect(ezccip.handleRead({ sender, data: hex.selector })).rejects.toThrow("expected hex");
		expect(ezccip.handleRead({ sender, data: origin.selector })).rejects.toThrow("invalid origin");
		expect(ezccip.handleRead({ sender, data: ttl.selector })).rejects.toThrow("invalid ttl");
		expect(ezccip.handleRead({ sender, data: ttl.selector, ttl: Number.NaN })).rejects.toThrow("invalid ttl");
	});

	test("fractional ttl", async () => {
		const ezccip = new EZCCIP({ signer: generatePrivateKey(), ttl: 1.5 });
		const handler = ezccip.addHandler("function f()", () => {});
		expect((await ezccip.handleRead({ sender, data: handler.selector })).data).toBeDefined();
	});

	test("protocol is chosen after handlers run", async () => {
		const ezccip = new EZCCIP();
		const handler = ezccip.addHandler("function f()", (_, ctx) => {
			expect(ctx.protocol).toBe("raw");
			ctx.signer = generatePrivateKey();
			expect(ctx.protocol).toBe("ens");
		});
		const { context } = await ezccip.handleRead({ sender, data: handler.selector });
		expect(context.protocol).toBe("ens");
	});

	test("fetch requires optional extra", () => {
		expectTypeOf(new EZCCIP().fetch).toEqualTypeOf<(request: Request) => Promise<Response>>();
		expectTypeOf(new EZCCIP<{ env: string }>().fetch).toBeNever();
		expectTypeOf(new EZCCIP<{ env: string } | undefined>().fetch).not.toBeNever();
	});

	test("invalid input", async () => {
		const ezccip = new EZCCIP();
		const f = ezccip.addHandler("function f(uint256)", () => {});
		expect(ezccip.handleRead({ sender, data: `${f.selector}1234` })).rejects.toMatchObject({ status: 400 });
		expect(ezccip.handleRead({ sender, data: f.selector, origin: "0x1234" })).rejects.toMatchObject({ status: 400 });
		expect(ezccip.handleRead({ sender: "0x1234", data: "0x12345678" })).rejects.toMatchObject({ status: 400 });
		expect(ezccip.handleRead({ sender, data: "0x1234" })).rejects.toMatchObject({ status: 400 });
		expect(ezccip.handleRead({ sender, data: "0x12345678" })).rejects.toMatchObject({ status: 404 });
	});

	test("history", async () => {
		const ezccip = new EZCCIP();
		const handler = ezccip.addHandler("f(string s, uint256 x) returns (uint256)", (_, ctx) => {
			ctx.history.show = ["custom"];
			ctx.history.name = "Chonk";
			return [0n];
		});
		const { context } = await ezccip.handleRead({ sender, data: encode(handler.abiFunction, ["a", 1n]) });
		expect(String(context.history)).toBe("Chonk(custom)");
	});
});

describe("multicall", () => {
	const f = parseAbiItem("function f(uint256 x) returns (uint256)");
	const fail = parseAbiItem("function fail()");
	const text = parseAbiItem("function text(bytes32, string) returns (string)");
	const ezccip = new EZCCIP();
	ezccip.addHandler(f, ([x]) => [x * 2n]);
	ezccip.addHandler(fail, () => {
		throw new CCIPReadError("nope");
	});
	ezccip.enableENSIP10({ resolve: (name) => ({ text: (key) => `${name}:${key}` }) });

	const multicall = (calls: Hex[]) => encode(MULTICALL, [calls]);
	const results = (data: Hex) => decodeFunctionResult({ abi: [MULTICALL], data });
	const errorMessage = (data: Hex) => decodeErrorResult({ abi: [SOLIDITY_ERROR], data }).args[0];

	test("subcalls and errors", async () => {
		const res = await ezccip.handleRead({ sender, data: multicall([encode(f, [1n]), encode(fail)]) });
		const [a, b] = results(res.data);
		expect(decodeFunctionResult({ abi: [f], data: a! })).toBe(2n);
		expect(errorMessage(b!)).toBe("nope");
		expect(String(res.context.history)).toBe("multicall()^2 [f(1) fail()<nope>]");
	});

	test("subcalls share context", async () => {
		const ezccip = new EZCCIP();
		ezccip.addHandler("function setTTL()", (_, ctx) => {
			ctx.ttl = 123;
		});
		const res = await ezccip.handleRead({ sender, data: multicall([toFunctionSelector("function setTTL()")]) });
		expect(res.context.ttl).toBe(123);
	});

	test("subcall cannot be multicall", async () => {
		const res = await ezccip.handleRead({ sender, data: multicall([multicall([encode(f, [3n])])]) });
		const [inner] = results(res.data);
		expect(errorMessage(inner!)).toContain("unsupported function");
	});

	test("multicall([resolve(name, multicall([...]))])", async () => {
		const node = pad("0x");
		const resolve = encode(RESOLVE, [
			bytesToHex(packetToBytes("raffy.eth")),
			multicall([encode(text, [node, "a"]), encode(text, [node, "b"])]),
		]);
		const res = await ezccip.handleRead({ sender, data: multicall([resolve]) });
		const [answer] = results(res.data);
		const [a, b] = results(answer!);
		expect(decodeFunctionResult({ abi: [text], data: a! })).toBe("raffy.eth:a");
		expect(decodeFunctionResult({ abi: [text], data: b! })).toBe("raffy.eth:b");
		expect(String(res.context.history)).toBe("multicall()^1 [resolve(raffy.eth).multicall()^2 [text(a) text(b)]]");
	});
});

describe("enableENSIP10", () => {
	const text = parseAbiItem("function text(bytes32, string) returns (string)");
	const inner = encode(text, [pad("0x"), "name"]);
	const resolve = (name: Hex) => encode(RESOLVE, [name, inner]);

	test("resolve", async () => {
		const ezccip = new EZCCIP();
		ezccip.enableENSIP10({
			resolve(name, ctx, extra) {
				expectTypeOf(ctx).toEqualTypeOf<CallContext>();
				expectTypeOf(extra).toEqualTypeOf<undefined>();
				return { text: (key) => `${name}:${key}` };
			},
		});
		const res = await ezccip.handleRead({ sender, data: resolve(bytesToHex(packetToBytes("raffy.eth"))) });
		expect(decodeFunctionResult({ abi: [text], data: res.data })).toBe("raffy.eth:name");
		expect(String(res.context.history)).toBe("resolve(raffy.eth).text(name)");
	});

	test("unreachable (default)", async () => {
		const ezccip = new EZCCIP();
		ezccip.enableENSIP10({ resolve: () => undefined });
		const res = await ezccip.handleRead({ sender, data: resolve("0x00") });
		expect(res.data).toBe(encodeErrorResult({ abi: [UNREACHABLE_NAME], args: ["0x00"] }));
	});

	test("unreachableAsEmpty", async () => {
		const ezccip = new EZCCIP();
		ezccip.enableENSIP10({ resolve: () => undefined, unreachableAsEmpty: true });
		const res = await ezccip.handleRead({ sender, data: resolve("0x00") });
		expect(decodeFunctionResult({ abi: [text], data: res.data })).toBe("");
	});
});
