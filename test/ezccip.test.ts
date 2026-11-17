import { describe, expect, expectTypeOf, test } from "bun:test";
import { Abi, AbiError, AbiFunction, AbiParameters, Address, Hex } from "ox";
import { EZCCIP, type Handler, History, RESOLVE_ABI, dnsEncode } from "../src/index.ts";

const sender = Address.from("0x0000000000000000000000000000000000000001");

async function call(
	ezccip: EZCCIP,
	abiFunction: AbiFunction.AbiFunction,
	args: readonly unknown[] = []
) {
	const data = AbiFunction.encodeData(abiFunction, args as never);
	const res = await ezccip.handleRead({ sender, data, protocol: "raw" });
	return AbiParameters.decode(abiFunction.outputs, res.data) as unknown;
}

describe("register", () => {
	test("signature", async () => {
		const ezccip = new EZCCIP();
		const h = ezccip.register(
			"function plus(uint256 a, uint256 b) returns (uint256 c)",
			(args, context, history) => {
				expectTypeOf(args).toEqualTypeOf<readonly [bigint, bigint]>();
				expectTypeOf(context.sender).toEqualTypeOf<Address.Address>();
				expectTypeOf(history).toEqualTypeOf<History>();
				const [a, b] = args;
				return [a + b];
			}
		);
		expect(h.signature).toBe("plus(uint256,uint256)");
		expect(h.selector).toBe(AbiFunction.getSelector("function plus(uint256,uint256)"));
		expect(await call(ezccip, h.abiFunction, [1n, 2n])).toEqual([3n]);
	});

	test("without function prefix", async () => {
		const ezccip = new EZCCIP();
		const h = ezccip.register("f(string x) returns (string)", ([x]) => {
			expectTypeOf(x).toEqualTypeOf<string>();
			return [x.toUpperCase()];
		});
		expect(await call(ezccip, h.abiFunction, ["abc"])).toEqual(["ABC"]);
	});

	test("AbiFunction", async () => {
		const ezccip = new EZCCIP();
		const fn = AbiFunction.from("function f(bytes32 x) returns (string)");
		ezccip.register(fn, ([x]) => {
			expectTypeOf(x).toEqualTypeOf<Hex.Hex>();
			return [x];
		});
		const x = Hex.padLeft("0x01", 32);
		expect(await call(ezccip, fn, [x])).toEqual([x]);
	});

	test("from Abi", async () => {
		const ezccip = new EZCCIP();
		const abi = Abi.from([
			"function f(uint256 x) returns (uint256)",
			"function f(string s) returns (string)",
			"function g((uint256 a, bool b)[] s) returns (bool)",
		]);
		ezccip.register(AbiFunction.fromAbi(abi, "f", { args: [0n] }), ([x]) => [x * 2n]);
		ezccip.register(AbiFunction.fromAbi(abi, "f", { args: [""] }), ([s]) => [s + "!"]);
		ezccip.register(AbiFunction.fromAbi(abi, "g"), ([s]) => {
			expectTypeOf(s).toEqualTypeOf<readonly { a: bigint; b: boolean }[]>();
			return [s.some((x) => x.b)];
		});
		expect(await call(ezccip, abi[0], [21n])).toEqual([42n]);
		expect(await call(ezccip, abi[1], ["hi"])).toEqual(["hi!"]);
		expect(await call(ezccip, abi[2], [[{ a: 1n, b: true }]])).toEqual([true]);
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
		const fn = AbiFunction.from("function f() returns (uint256)");
		ezccip.register(fn, () => [1n]);
		ezccip.register(fn, () => [2n]);
		expect(await call(ezccip, fn)).toEqual([2n]);
	});

	test("invalid", () => {
		const ezccip = new EZCCIP();
		expect(() => ezccip.register("event E()" as never, () => {})).toThrow();
	});
});

test("findHandler", () => {
	const ezccip = new EZCCIP();
	const fn = AbiFunction.from("function g(uint256 a, uint256 b) view returns (uint256)");
	ezccip.register(fn, () => [0n]);
	const selector = AbiFunction.getSelector(fn);
	expect(ezccip.findHandler("g")?.selector).toBe(selector);
	expect(ezccip.findHandler("g(uint256,uint256)")?.selector).toBe(selector);
	expect(ezccip.findHandler(selector)?.selector).toBe(selector);
	expect(ezccip.findHandler(fn)?.selector).toBe(selector);
	expect(ezccip.findHandler("multicall")).toBeDefined();
	expect(ezccip.findHandler("nope")).toBeUndefined();
});

describe("handler results", () => {
	const fn = AbiFunction.from("function f(uint256) returns (uint256)");
	const EXPECT = 1337n;
	const cases: Record<string, Handler<typeof fn>> = {
		tuple: ([x]) => [x],
		hex: ([x]) => AbiParameters.encode(fn.outputs, [x]),
		bytes: ([x]) => Hex.toBytes(Hex.fromNumber(x, { size: 32 })),
		async: async ([x]) => [x],
	};
	for (const [label, impl] of Object.entries(cases)) {
		test(label, async () => {
			const ezccip = new EZCCIP();
			ezccip.register(fn, impl);
			expect(await call(ezccip, fn, [EXPECT])).toEqual([EXPECT]);
		});
	}
	test("void", async () => {
		const ezccip = new EZCCIP();
		const g = AbiFunction.from("function g()");
		ezccip.register(g, () => {});
		const { data } = await ezccip.handleRead({ sender, data: AbiFunction.encodeData(g) });
		expect(data).toBe("0x");
	});
});

describe("handleRead", () => {
	test("context", async () => {
		const ezccip = new EZCCIP({ ttl: 5 });
		const fn = AbiFunction.from("function f() returns (address, address)");
		ezccip.register(fn, (_, context, history) => {
			expect(context.calldata).toBe(history.calldata!);
			expect(context.ttl).toBe(5);
			expect(context.protocol).toBe("raw");
			expect(context.signer).toBeUndefined();
			return [context.sender, context.origin];
		});
		const origin = "0x0000000000000000000000000000000000000002";
		const res = await ezccip.handleRead({
			sender: sender.toLowerCase() as Hex.Hex,
			data: AbiFunction.encodeData(fn),
			origin,
		});
		expect(res.context.sender).toBe(sender);
		expect(AbiFunction.decodeResult(fn, res.data)).toEqual([sender, origin]);
	});

	test("extra context", async () => {
		const ezccip = new EZCCIP<{ env: { greeting: string } }>();
		ezccip.register("f() returns (string)", (_, context) => [context.env.greeting]);
		const { data } = await ezccip.handleRead({
			sender,
			data: AbiFunction.getSelector("function f()"),
			extra: { env: { greeting: "hello" } },
		});
		expect(AbiParameters.decode(AbiParameters.from(["string"]), data)).toEqual(["hello"]);
	});

	test("invalid input", async () => {
		const ezccip = new EZCCIP();
		expect(ezccip.handleRead({ sender: "0x1234", data: "0x12345678" })).rejects.toMatchObject({ status: 400 });
		expect(ezccip.handleRead({ sender, data: "0x1234" })).rejects.toMatchObject({ status: 400 });
		expect(ezccip.handleRead({ sender, data: "0x12345678" })).rejects.toThrow("unsupported ccip method");
	});

	test("history", async () => {
		const ezccip = new EZCCIP();
		ezccip.register("f(string s, uint256 x) returns (uint256)", (_, __, history) => {
			history.show = ["custom"];
			history.name = "Chonk";
			return [0n];
		});
		const fn = AbiFunction.from("function f(string, uint256)");
		const { history } = await ezccip.handleRead({ sender, data: AbiFunction.encodeData(fn, ["a", 1n]) });
		expect(String(history)).toBe("Chonk(custom)");
	});
});

describe("multicall", () => {
	const multicall = AbiFunction.fromAbi(RESOLVE_ABI, "multicall");
	const f = AbiFunction.from("function f(uint256 x) returns (uint256)");
	const g = AbiFunction.from("function g()");
	function make(recursionLimit?: number) {
		const ezccip = new EZCCIP({ recursionLimit });
		ezccip.register(f, ([x]) => [x * 2n]);
		ezccip.register(g, () => {
			throw new Error("nope");
		});
		return ezccip;
	}

	test("calls + errors", async () => {
		const ezccip = make();
		const data = AbiFunction.encodeData(multicall, [
			[AbiFunction.encodeData(f, [1n]), AbiFunction.encodeData(g)],
		]);
		const res = await ezccip.handleRead({ sender, data });
		const [a, b] = AbiFunction.decodeResult(multicall, res.data);
		expect(AbiFunction.decodeResult(f, a!)).toBe(2n);
		expect(AbiError.decode(AbiError.from("error Error(string)"), b!)).toBe("nope");
		expect(String(res.history)).toBe("multicall()^2 [f(1) g()<nope>]");
	});

	test("nested", async () => {
		const ezccip = make(2);
		const inner = AbiFunction.encodeData(multicall, [[AbiFunction.encodeData(f, [3n])]]);
		const data = AbiFunction.encodeData(multicall, [[inner]]);
		const res = await ezccip.handleRead({ sender, data });
		const [a] = AbiFunction.decodeResult(multicall, res.data);
		const [b] = AbiFunction.decodeResult(multicall, a!);
		expect(AbiFunction.decodeResult(f, b!)).toBe(6n);
	});

	test("recursion limit", async () => {
		const ezccip = make(1);
		const inner = AbiFunction.encodeData(multicall, [[AbiFunction.encodeData(f, [3n])]]);
		const data = AbiFunction.encodeData(multicall, [[inner]]);
		const res = await ezccip.handleRead({ sender, data });
		const [a] = AbiFunction.decodeResult(multicall, res.data);
		expect(AbiError.decode(AbiError.from("error Error(string)"), a!)).toContain("unsupported ccip method");
	});

	test("disabled", async () => {
		const ezccip = make(0);
		const data = AbiFunction.encodeData(multicall, [[]]);
		expect(ezccip.handleRead({ sender, data })).rejects.toThrow("unsupported ccip method");
	});
});

describe("enableENSIP10", () => {
	const resolve = AbiFunction.fromAbi(RESOLVE_ABI, "resolve");
	const text = AbiFunction.from("function text(bytes32, string) returns (string)");
	const inner = AbiFunction.encodeData(text, [Hex.padLeft("0x", 32), "name"]);

	test("resolve", async () => {
		const ezccip = new EZCCIP();
		ezccip.enableENSIP10((name) => ({ text: (key) => `${name}:${key}` }));
		const data = AbiFunction.encodeData(resolve, [dnsEncode("raffy.eth"), inner]);
		const res = await ezccip.handleRead({ sender, data });
		expect(AbiFunction.decodeResult(text, res.data)).toBe("raffy.eth:name");
		expect(String(res.history)).toBe("resolve(raffy.eth).text(name)");
	});

	test("unreachable (default)", async () => {
		const ezccip = new EZCCIP();
		ezccip.enableENSIP10(() => undefined);
		const data = AbiFunction.encodeData(resolve, ["0x00", inner]);
		const res = await ezccip.handleRead({ sender, data });
		expect(res.data).toBe(AbiError.encode(AbiError.fromAbi(RESOLVE_ABI, "UnreachableName"), ["0x00"]));
	});

	test("unreachableAsEmpty", async () => {
		const ezccip = new EZCCIP();
		ezccip.enableENSIP10(() => undefined, { unreachableAsEmpty: true });
		const data = AbiFunction.encodeData(resolve, ["0x00", inner]);
		const res = await ezccip.handleRead({ sender, data });
		expect(AbiFunction.decodeResult(text, res.data)).toBe("");
	});
});
