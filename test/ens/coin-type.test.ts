import { expect, test } from "bun:test";
import { COIN_TYPE_DEFAULT, chainFromCoinType, formatCoinType } from "../../src/index.js";

test("chainFromCoinType", () => {
	expect(chainFromCoinType(60n)).toBe(1);
	expect(chainFromCoinType(COIN_TYPE_DEFAULT)).toBe(0);
	expect(chainFromCoinType(COIN_TYPE_DEFAULT | 10n)).toBe(10);
	expect(chainFromCoinType(0n)).toBe(0);
});

test("formatCoinType", () => {
	expect(formatCoinType(COIN_TYPE_DEFAULT | 10n)).toBe("evm:10");
	expect(formatCoinType(60n)).toBe("60");
});
