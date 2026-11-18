import { describe, expect, test } from "bun:test";
import { bytesToHex } from "viem";
import { packetToBytes } from "viem/ens";
import { CCIPReadError, dnsDecodeLabels, dnsDecodeName } from "../../src/index.js";

describe("dnsDecodeName / dnsDecodeLabels", () => {
	for (const name of ["raffy.eth", "a.b.c.d.e", "💩.eth", ""]) {
		test(JSON.stringify(name), () => {
			const bytes = packetToBytes(name);
			expect(dnsDecodeName(bytes)).toBe(name);
			expect(dnsDecodeName(bytesToHex(bytes))).toBe(name);
			expect(dnsDecodeLabels(bytes)).toEqual(name ? name.split(".") : []);
		});
	}
	test("invalid", () => {
		expect(() => dnsDecodeLabels("0x")).toThrow(CCIPReadError);
		expect(() => dnsDecodeLabels("0x0100")).toThrow(); // overflow
		expect(() => dnsDecodeLabels("0x000000")).toThrow(); // trailing
		expect(() => dnsDecodeLabels("0x012e00")).toThrow(); // "."
		expect(() => dnsDecodeLabels("0x01ff00")).toThrow(); // invalid utf8
	});
});
