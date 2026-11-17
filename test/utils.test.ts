import { expect, test } from "bun:test";
import { decodeErrorResult, parseAbiItem } from "viem";
import { asciiize, CCIPReadError, encodeErrorString } from "../src/index.js";

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

test("encodeErrorString", () => {
	const data = encodeErrorString(new Error("chonk"));
	const { args } = decodeErrorResult({ abi: [parseAbiItem("error Error(string)")], data });
	expect(args).toEqual(["chonk"]);
});
