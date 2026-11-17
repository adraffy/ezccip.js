import { describe, expect, test } from "bun:test";
import { concat, decodeFunctionResult, encodeFunctionData, isHex, keccak256, numberToHex, parseAbiItem } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
	EZCCIP,
	type EZCCIPOptions,
	getResponseHash,
	type SignedProtocol,
	type SignerLike,
	toSigner,
	verifyResponse,
} from "../src/index.js";

const privateKey = generatePrivateKey();
const { address } = privateKeyToAccount(privateKey);
const sender = "0x0000000000000000000000000000000000000001";
const origin = "0x0000000000000000000000000000000000000002";

const fn = parseAbiItem("function f(string s) returns (string)");
const request = encodeFunctionData({ abi: [fn], args: ["chonk"] });
const decode = (data: `0x${string}`) => decodeFunctionResult({ abi: [fn], data });

function make(options?: EZCCIPOptions) {
	const ezccip = new EZCCIP(options);
	ezccip.addHandler(fn, ([s]) => [s.toUpperCase()]);
	return ezccip;
}

describe("toSigner", () => {
	test("private key", () => expect(toSigner(privateKey).address).toBe(address));
	test("checksums", () => {
		const signer = toSigner({ address: address.toLowerCase() as `0x${string}`, sign: async () => "0x" });
		expect(signer.address).toBe(address);
	});
	test("requires sign()", () => expect(() => toSigner({ address })).toThrow());
});

test("default protocol", () => {
	expect(new EZCCIP().protocol).toBe("raw");
	expect(new EZCCIP({ signer: privateKey }).protocol).toBe("ens");
	expect(new EZCCIP({ signer: privateKey, protocol: "tor" }).protocol).toBe("tor");
});

test("raw", async () => {
	const { data, context } = await make().handleRequest(sender, request);
	expect(context.protocol).toBe("raw");
	expect(decode(data)).toBe("CHONK");
});

for (const protocol of ["ens", "tor"] as const satisfies SignedProtocol[]) {
	describe(protocol, () => {
		const signers: Record<string, SignerLike> = {
			"private key": privateKey,
			"viem account": privateKeyToAccount(privateKey),
			"custom signer": { address, sign: privateKeyToAccount(privateKey).sign },
		};
		for (const [label, signer] of Object.entries(signers)) {
			test(label, async () => {
				const ezccip = make({ signer, protocol, ttl: 30 });
				expect(ezccip.signerAddress).toBe(address);
				const { data: response, context } = await ezccip.handleRequest(sender, request, { origin });
				expect(context.protocol).toBe(protocol);
				const verified = await verifyResponse({ protocol, response, calldata: request, origin });
				expect(verified.signer).toBe(address);
				expect(decode(verified.result)).toBe("CHONK");
				const now = Math.floor(Date.now() / 1000);
				expect(Number(verified.expires)).toBeGreaterThanOrEqual(now + 29);
				expect(Number(verified.expires)).toBeLessThanOrEqual(now + 31);
			});
		}

		test("origin defaults to sender", async () => {
			const { data: response } = await make({ signer: privateKey, protocol }).handleRequest(sender, request);
			expect((await verifyResponse({ protocol, response, calldata: request, origin: sender })).signer).toBe(address);
			expect((await verifyResponse({ protocol, response, calldata: request, origin })).signer).not.toBe(address);
		});

		test("per-request signer", async () => {
			const other = generatePrivateKey();
			const { data: response } = await make({ signer: privateKey, protocol }).handleRequest(sender, request, {
				signer: other,
			});
			const verified = await verifyResponse({ protocol, response, calldata: request, origin: sender });
			expect(verified.signer).toBe(privateKeyToAccount(other).address);
		});

		test("requires signer", async () => {
			expect(make({ protocol }).handleRequest(sender, request)).rejects.toThrow("requires a signer");
		});
	});
}

test("handler changes protocol", async () => {
	const ezccip = new EZCCIP({ signer: privateKey, protocol: "raw" });
	ezccip.addHandler(fn, ([s], ctx) => {
		ctx.protocol = "tor";
		ctx.ttl = 1000;
		ctx.origin = origin;
		return [s];
	});
	const { data: response } = await ezccip.handleRequest(sender, request);
	const verified = await verifyResponse({ protocol: "tor", response, calldata: request, origin });
	expect(verified.signer).toBe(address);
	expect(Number(verified.expires)).toBeGreaterThan(Date.now() / 1000 + 900);
	expect(isHex(verified.result)).toBe(true);
});

// packed layouts expected by the onchain verifiers
test("hash layout", () => {
	const p = { origin, expires: 1n, calldata: "0x12345678", result: "0x" } as const;
	const tail = [origin, numberToHex(1n, { size: 8 }), keccak256(p.calldata), keccak256(p.result)] as const;
	expect(getResponseHash({ protocol: "ens", ...p })).toBe(keccak256(concat(["0x1900", ...tail])));
	expect(getResponseHash({ protocol: "tor", ...p })).toBe(keccak256(concat(tail)));
});

test("handler changes signer", async () => {
	const other = generatePrivateKey();
	const ezccip = new EZCCIP({ signer: privateKey });
	ezccip.addHandler(fn, ([s], ctx) => {
		ctx.signer = other; // private key or LocalAccount
		return [s];
	});
	const { data: response } = await ezccip.handleRequest(sender, request);
	const verified = await verifyResponse({ protocol: "ens", response, calldata: request, origin: sender });
	expect(verified.signer).toBe(privateKeyToAccount(other).address);
});

describe("verifyResponse", () => {
	test("expired", async () => {
		const ezccip = make({ signer: privateKey, ttl: 10 });
		const { data: response } = await ezccip.handleRequest(sender, request);
		const now = Math.floor(Date.now() / 1000) + 11;
		expect(verifyResponse({ protocol: "ens", response, calldata: request, origin: sender, now })).rejects.toThrow(
			"expired",
		);
	});
	test("valid through its last second, like the onchain verifiers", async () => {
		const { data: response } = await make({ signer: privateKey }).handleRequest(sender, request);
		const { expires } = await verifyResponse({ protocol: "ens", response, calldata: request, origin: sender });
		const p = { protocol: "ens", response, calldata: request, origin: sender } as const;
		expect((await verifyResponse({ ...p, now: expires })).expires).toBe(expires);
		expect(verifyResponse({ ...p, now: expires + 1n })).rejects.toThrow("expired");
	});
	test("expected signer", async () => {
		const { data: response } = await make({ signer: privateKey }).handleRequest(sender, request);
		const verify = (signer: `0x${string}`) =>
			verifyResponse({ protocol: "ens", response, calldata: request, origin: sender, signer });
		expect((await verify(address)).signer).toBe(address);
		expect(verify(privateKeyToAccount(generatePrivateKey()).address)).rejects.toThrow("unexpected signer");
	});
});
