import { describe, expect, test } from "bun:test";
import { History } from "../src/index.js";

describe("History", () => {
	test("selector until named", () => expect(String(new History("0x12345678abcd"))).toBe("<0x12345678>()"));
	test("show", () => {
		const h = new History("0x12345678");
		h.name = "f";
		h.show = [1, 2n, "💩"];
		expect(String(h)).toBe("f(1,2,{1F4A9})");
		h.show = false;
		expect(String(h)).toBe("f()");
	});
	test("error message is escaped", () => {
		const h = new History("0x12345678");
		h.error = new Error("a\nb");
		expect(String(h)).toBe("<0x12345678>()<a{0A}b>");
	});
	test("error", () => {
		const h = new History("0x12345678");
		h.name = "f";
		h.error = new Error("wtf");
		expect(String(h)).toBe("f()<wtf>");
	});
	test("addInner()", () => {
		const h = new History("0x12345678");
		h.name = "resolve";
		h.addInner("0x87654321").name = "text";
		expect(String(h)).toBe("resolve().text()");
	});
	test("addChild()", () => {
		const h = new History("0x12345678");
		h.name = "multicall";
		h.addChild("0x00000001").name = "a";
		h.addChild("0x00000002");
		expect(String(h)).toBe("multicall()^2 [a() <0x00000002>()]");
	});
	test("not thenable", async () => {
		const h = new History("0x12345678");
		expect(await Promise.resolve(h)).toBe(h);
	});
});
