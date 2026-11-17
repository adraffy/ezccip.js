import { describe, expect, test } from "bun:test";
import { bytesToHex } from "viem";
import { packetToBytes } from "viem/ens";
import { CCIPReadError, dnsDecode } from "../../src/index.js";

describe("dnsDecode", () => {
	for (const name of ["raffy.eth", "a.b.c.d.e", "💩.eth", ""]) {
		test(JSON.stringify(name), () => {
			const bytes = packetToBytes(name);
			expect(dnsDecode(bytes).join(".")).toBe(name);
			expect(dnsDecode(bytesToHex(bytes)).join(".")).toBe(name);
		});
	}
	test("invalid", () => {
		expect(() => dnsDecode("0x")).toThrow(CCIPReadError);
		expect(() => dnsDecode("0x0100")).toThrow(); // overflow
		expect(() => dnsDecode("0x000000")).toThrow(); // trailing
		expect(() => dnsDecode("0x012e00")).toThrow(); // "."
		expect(() => dnsDecode("0x01ff00")).toThrow(); // invalid utf8
	});
});
