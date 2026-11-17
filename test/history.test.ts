import { describe, expect, test } from "bun:test";
import { History } from "../src/index.js";

describe("History", () => {
	test("recursion limit", () => {
		expect(() => new History(0).enter()).toThrow();
		expect(() => new History(1).enter().enter()).toThrow();
		expect(() => new History(2).enter().enter()).not.toThrow();
	});
	test("no name", () => expect(String(new History(1))).toBe("<null>()"));
	test("calldata", () => {
		const h = new History(1);
		h.calldata = "0x12345678abcd";
		expect(String(h)).toBe("<0x12345678>()");
	});
	test("name", () => {
		const h = new History(1);
		h.name = "f";
		h.show = [1, 2n, "💩"];
		expect(String(h)).toBe("f(1,2,{1F4A9})");
	});
	test("error", () => {
		const h = new History(1);
		h.name = "f";
		h.error = new Error("wtf");
		expect(String(h)).toBe("f()<wtf>");
	});
	test("chain()", () => {
		const h = new History(0);
		const next = h.chain();
		expect(h.last()).toBe(next);
		expect(String(h)).toBe("<null>().<null>()");
	});
	test("children", () => {
		const h = new History(1);
		h.name = "multicall";
		h.show = false;
		h.enter().name = "a";
		h.enter().name = "b";
		expect(String(h)).toBe("multicall()^2 [a() b()]");
	});
	test("direct show", () => {
		const h = new History(0);
		h.name = "f";
		h.show = "a";
		expect(String(h)).toBe("f(a)");
	});
	test("lazy show", () => {
		const h = new History(0);
		h.name = "f";
		h.show = () => ["a", "b"];
		expect(String(h)).toBe("f(a,b)");
	});
	test("not thenable", async () => {
		const h = new History(0);
		expect(await Promise.resolve(h)).toBe(h);
	});
});
