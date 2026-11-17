import { describe, expect, test } from "bun:test";
import { AbiFunction, Address, Hash, Hex, Secp256k1 } from "ox";
import { privateKeyToAccount } from "viem/accounts";
import {
	EZCCIP,
	getResponseHash,
	type SignedProtocol,
	privateKeyToSigner,
	type SignerLike,
	toSigner,
	verifyResponse,
} from "../src/index.ts";

const privateKey = Secp256k1.randomPrivateKey();
const address = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey }), { checksum: true });
const sender = "0x0000000000000000000000000000000000000001";
const origin = "0x0000000000000000000000000000000000000002";

const fn = AbiFunction.from("function f(string s) returns (string)");
const request = AbiFunction.encodeData(fn, ["chonk"]);

function make(options?: ConstructorParameters<typeof EZCCIP>[0]) {
	const ezccip = new EZCCIP(options);
	ezccip.register(fn, ([s]) => [s.toUpperCase()]);
	return ezccip;
}

test("privateKeyToSigner", () => {
	expect(privateKeyToSigner(privateKey).address).toBe(address);
});

test("signer without sign()", () => {
	expect(() => toSigner({ address })).toThrow();
});

test("raw", async () => {
	const ezccip = make();
	const { data, context } = await ezccip.handleRead({ sender, data: request });
	expect(context.protocol).toBe("raw");
	expect(AbiFunction.decodeResult(fn, data)).toBe("CHONK");
});

for (const protocol of ["ens", "tor"] as const satisfies SignedProtocol[]) describe(protocol, () => {
	const signers: Record<string, SignerLike> = {
		"private key": privateKey,
		"viem account": privateKeyToAccount(privateKey),
		"custom signer": privateKeyToSigner(privateKey),
	};
	for (const [label, signer] of Object.entries(signers)) {
		test(label, async () => {
			const ezccip = make({ signer, protocol, ttl: 30 });
			expect(ezccip.signer).toBe(address);
			const { data: response, context } = await ezccip.handleRead({ sender, data: request, origin });
			expect(context.protocol).toBe(protocol);
			const decoded = verifyResponse({ protocol, response, request, origin });
			expect(decoded.signer).toBe(address);
			expect(AbiFunction.decodeResult(fn, decoded.result)).toBe("CHONK");
			const now = Math.floor(Date.now() / 1000);
			expect(Number(decoded.expires)).toBeGreaterThanOrEqual(now + 29);
			expect(Number(decoded.expires)).toBeLessThanOrEqual(now + 31);
		});
	}

	test("origin defaults to sender", async () => {
		const { data: response } = await make({ signer: privateKey, protocol }).handleRead({ sender, data: request });
		expect(verifyResponse({ protocol, response, request, origin: sender }).signer).toBe(address);
		expect(verifyResponse({ protocol, response, request, origin }).signer).not.toBe(address);
	});

	test("per-request signer", async () => {
		const other = Secp256k1.randomPrivateKey();
		const { data: response } = await make({ signer: privateKey, protocol }).handleRead({
			sender,
			data: request,
			signer: other,
		});
		expect(verifyResponse({ protocol, response, request, origin: sender }).signer).toBe(
			privateKeyToSigner(other).address
		);
	});

	test("missing signer", async () => {
		expect(make({ protocol }).handleRead({ sender, data: request })).rejects.toThrow("requires a signer");
	});

	test.skipIf(protocol !== "ens")("explicit raw with signer", async () => {
		const { data } = await make({ signer: privateKey, protocol: "raw" }).handleRead({ sender, data: request });
		expect(AbiFunction.decodeResult(fn, data)).toBe("CHONK");
	});
});

test("handler changes protocol", async () => {
	const ezccip = new EZCCIP({ signer: privateKey, protocol: "raw" });
	ezccip.register(fn, ([s], context) => {
		context.protocol = "ens";
		context.ttl = 1000;
		context.origin = origin;
		return [s];
	});
	const { data: response } = await ezccip.handleRead({ sender, data: request });
	const decoded = verifyResponse({ protocol: "ens", response, request, origin });
	expect(decoded.signer).toBe(address);
	expect(Number(decoded.expires)).toBeGreaterThan(Date.now() / 1000 + 900);
	expect(Hex.validate(decoded.result)).toBe(true);
});

test("default protocol", () => {
	expect(new EZCCIP().protocol).toBe("raw");
	expect(new EZCCIP({ signer: privateKey }).protocol).toBe("ens");
	expect(new EZCCIP({ signer: privateKey, protocol: "tor" }).protocol).toBe("tor");
});

// packed layouts expected by the onchain verifiers
test("hash layout", () => {
	const p = {
		origin: "0x0000000000000000000000000000000000000002",
		expires: 1n,
		request: "0x12345678",
		result: "0x",
	} as const;
	const ens = getResponseHash("ens", p);
	const tor = getResponseHash("tor", p);
	expect(ens).not.toBe(tor);
	const packed = (prefix: string) =>
		Hex.concat(
			prefix as Hex.Hex,
			p.origin,
			Hex.fromNumber(1n, { size: 8 }),
			Hash.keccak256(p.request),
			Hash.keccak256(p.result)
		);
	expect(ens).toBe(Hash.keccak256(packed("0x1900")));
	expect(tor).toBe(Hash.keccak256(packed("0x")));
});
