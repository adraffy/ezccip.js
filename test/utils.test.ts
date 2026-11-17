import { expect, test } from "bun:test";
import { decodeErrorResult, parseAbiItem } from "viem";
import { CCIPReadError, encodeErrorString, publicErrorMessage } from "../src/index.js";
import { asciiize } from "../src/utils.js";

test("asciiize", () => {
	expect(asciiize("💩")).toBe("{1F4A9}");
	expect(asciiize("a\nb")).toBe("a{0A}b");
});

test("CCIPReadError", () => {
	const cause = new Error("inner");
	const error = new CCIPReadError("outer", { status: 400, cause });
	expect(error.status).toBe(400);
	expect(error.cause).toBe(cause);
	expect(error.name).toBe("CCIPReadError");
	expect(new CCIPReadError("x").status).toBe(500);
});

test("publicErrorMessage", () => {
	expect(publicErrorMessage(new CCIPReadError("chonk"))).toBe("chonk");
	expect(publicErrorMessage(new Error("secret"))).toBe("internal error");
	expect(publicErrorMessage("x")).toBe("internal error");
});

test("encodeErrorString", () => {
	const decode = (data: `0x${string}`) =>
		decodeErrorResult({ abi: [parseAbiItem("error Error(string)")], data }).args[0];
	expect(decode(encodeErrorString("chonk"))).toBe("chonk");
	expect(decode(encodeErrorString(new CCIPReadError("chonk")))).toBe("chonk");
	expect(decode(encodeErrorString(new Error("secret")))).toBe("internal error");
});
