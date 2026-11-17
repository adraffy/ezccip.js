import { describe, expect, test } from "bun:test";
import {
	asciiize,
	CCIPReadError,
	chainFromCoinType,
	COIN_TYPE_DEFAULT,
	dnsEncode,
	labelsFromDnsEncoded,
} from "../src/index.ts";

test("asciiize", () => {
	expect(asciiize("💩")).toBe("{1F4A9}");
	expect(asciiize("a\nb")).toBe("a{0A}b");
});

describe("dns", () => {
	for (const name of ["raffy.eth", "a.b.c.d.e", "💩.eth", ""]) {
		test(JSON.stringify(name), () => {
			expect(labelsFromDnsEncoded(dnsEncode(name)).join(".")).toBe(name);
		});
	}
	test("invalid", () => {
		expect(() => labelsFromDnsEncoded("0x")).toThrow(CCIPReadError);
		expect(() => labelsFromDnsEncoded("0x0100")).toThrow(); // overflow
		expect(() => labelsFromDnsEncoded("0x000000")).toThrow(); // trailing
		expect(() => labelsFromDnsEncoded("0x012e00")).toThrow(); // "."
		expect(() => dnsEncode("a..b")).toThrow();
	});
});

test("chainFromCoinType", () => {
	expect(chainFromCoinType(60n)).toBe(1);
	expect(chainFromCoinType(COIN_TYPE_DEFAULT)).toBe(0);
	expect(chainFromCoinType(COIN_TYPE_DEFAULT | 10n)).toBe(10);
	expect(chainFromCoinType(0n)).toBe(0);
});

test("CCIPReadError", () => {
	const cause = new Error("inner");
	const error = new CCIPReadError("outer", { status: 400, cause });
	expect(error.status).toBe(400);
	expect(error.cause).toBe(cause);
	expect(new CCIPReadError("x").status).toBe(500);
});
