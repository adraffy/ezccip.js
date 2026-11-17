import { describe, expect, test } from "bun:test";
import { History } from "../src/index.js";

describe("History", () => {
	test("empty", () => expect(String(new History())).toBe("<null>()"));
	test("calldata", () => {
		const h = new History();
		h.calldata = "0x12345678abcd";
		expect(String(h)).toBe("<0x12345678>()");
	});
	test("args", () => {
		const h = new History();
		h.name = "f";
		h.args = [1, 2n, "💩"];
		expect(String(h)).toBe("f(1,2,{1F4A9})");
	});
	test("show overrides args", () => {
		const h = new History();
		h.name = "f";
		h.args = [1];
		h.show = "a";
		expect(String(h)).toBe("f(a)");
		h.show = false;
		expect(String(h)).toBe("f()");
		h.show = () => ["a", "b"];
		expect(String(h)).toBe("f(a,b)");
	});
	test("error", () => {
		const h = new History();
		h.name = "f";
		h.error = new Error("wtf");
		expect(String(h)).toBe("f()<wtf>");
	});
	test("addInner()", () => {
		const h = new History();
		h.name = "resolve";
		h.addInner().name = "text";
		expect(String(h)).toBe("resolve().text()");
	});
	test("addChild()", () => {
		const h = new History();
		h.name = "multicall";
		h.addChild().name = "a";
		h.addChild().name = "b";
		expect(String(h)).toBe("multicall()^2 [a() b()]");
	});
	test("not thenable", async () => {
		const h = new History();
		expect(await Promise.resolve(h)).toBe(h);
	});
});
