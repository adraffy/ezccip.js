import { describe, expect, test } from "bun:test";
import { AbiFunction, Hex, Secp256k1 } from "ox";
import { EZCCIP, privateKeyToSigner, verifyResponse } from "../src/index.ts";
import { serveEZCCIP } from "../src/serve.ts";

const SENDER = "0x0000000000000000000000000000000000000001";
const f = AbiFunction.from("function f(uint256 x) returns (uint256)");
const fail = AbiFunction.from("function fail()");

function post(endpoint: string, data: Hex.Hex) {
	return fetch(endpoint, { method: "POST", body: JSON.stringify({ sender: SENDER, data }) });
}

describe("serveEZCCIP", () => {
	test("instance + logging", async () => {
		const lines: string[] = [];
		const ezccip = new EZCCIP();
		ezccip.register(f, ([x]) => [x + 1n]);
		ezccip.register(fail, () => {
			throw new Error("chonk");
		});
		const ccip = serveEZCCIP(ezccip, { log: (...a) => lines.push(a.map(String).join(" ")) });
		expect(ccip.endpoint).toBe(`http://localhost:${ccip.port}`);
		expect(ccip.signer).toBeUndefined();
		expect(ccip.context).toBe(ccip.endpoint);

		const res = await post(ccip.endpoint, AbiFunction.encodeData(f, [1n]));
		const { data } = (await res.json()) as { data: Hex.Hex };
		expect(AbiFunction.decodeResult(f, data)).toBe(2n);
		expect((await post(ccip.endpoint, AbiFunction.encodeData(fail))).status).toBe(500);

		await ccip.shutdown();
		expect(lines).toHaveLength(4);
		expect(lines[0]).toBe(`Serving "raw" ${ccip.endpoint}`);
		expect(lines[1]).toMatch(/ \/ f\(1\)$/);
		expect(lines[2]).toMatch(/ POST \/ 500 Error: chonk/);
		expect(lines[3]).toMatch(/^Shutdown<\d+ms>$/);
	});

	test("record function + signer", async () => {
		const privateKey = Secp256k1.randomPrivateKey();
		const signer = privateKeyToSigner(privateKey).address;
		await using ccip = serveEZCCIP(() => ({ text: () => "Raffy" }), {
			signer: privateKey,
			protocol: "tor",
			log: false,
		});
		expect(ccip.signer).toBe(signer);
		expect(ccip.context).toBe(`${signer} ${ccip.endpoint}`);
		expect(ccip.ezccip.protocol).toBe("tor");
		expect(ccip.ezccip.findHandler("resolve")).toBeDefined();
	});

	test("verify over http", async () => {
		const privateKey = Secp256k1.randomPrivateKey();
		const ezccip = new EZCCIP({ signer: privateKey });
		ezccip.register(f, ([x]) => [x]);
		await using ccip = serveEZCCIP(ezccip, { log: false });
		const request = AbiFunction.encodeData(f, [7n]);
		const { data: response } = (await (await post(ccip.endpoint, request)).json()) as { data: Hex.Hex };
		const { result, signer } = verifyResponse({ protocol: "ens", response, request, origin: SENDER });
		expect(signer).toBe(ccip.signer!);
		expect(AbiFunction.decodeResult(f, result)).toBe(7n);
	});

	test("shutdown is idempotent", async () => {
		const ccip = serveEZCCIP(new EZCCIP(), { log: false });
		expect(ccip.shutdown()).toBe(ccip.shutdown());
		await ccip.shutdown();
		await ccip.shutdown();
		expect(fetch(ccip.endpoint)).rejects.toThrow();
	});
});
