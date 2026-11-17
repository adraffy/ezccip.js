import { describe, expect, test } from "bun:test";
import { decodeFunctionResult, encodeFunctionData, type Hex, parseAbiItem, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EZCCIP, verifyResponse } from "../src/index.js";
import { serveEZCCIP } from "../src/serve.js";

const SENDER = "0x0000000000000000000000000000000000000001";
const f = parseAbiItem("function f(uint256 x) returns (uint256)");
const fail = parseAbiItem("function fail()");

function post(endpoint: string, data: Hex) {
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

		const res = await post(ccip.endpoint, encodeFunctionData({ abi: [f], args: [1n] }));
		const { data } = (await res.json()) as { data: Hex };
		expect(decodeFunctionResult({ abi: [f], data })).toBe(2n);
		expect((await post(ccip.endpoint, toFunctionSelector(fail))).status).toBe(500);

		await ccip.shutdown();
		expect(lines).toHaveLength(4);
		expect(lines[0]).toBe(`Serving "raw" ${ccip.endpoint}`);
		expect(lines[1]).toMatch(/ \/ f\(1\)$/);
		expect(lines[2]).toMatch(/ POST \/ 500 Error: chonk/);
		expect(lines[3]).toMatch(/^Shutdown<\d+ms>$/);
	});

	test("record function + signer", async () => {
		const privateKey = generatePrivateKey();
		const { address } = privateKeyToAccount(privateKey);
		await using ccip = serveEZCCIP(() => ({ text: () => "Raffy" }), {
			signer: privateKey,
			protocol: "tor",
			log: false,
		});
		expect(ccip.signer).toBe(address);
		expect(ccip.context).toBe(`${address} ${ccip.endpoint}`);
		expect(ccip.ezccip.protocol).toBe("tor");
		expect(ccip.ezccip.getFunction("resolve")).toBeDefined();
	});

	test("verify over http", async () => {
		const ezccip = new EZCCIP({ signer: generatePrivateKey() });
		ezccip.register(f, ([x]) => [x]);
		await using ccip = serveEZCCIP(ezccip, { log: false });
		const request = encodeFunctionData({ abi: [f], args: [7n] });
		const { data: response } = (await (await post(ccip.endpoint, request)).json()) as { data: Hex };
		const { result, signer } = await verifyResponse({ protocol: "ens", response, request, origin: SENDER });
		expect(signer).toBe(ccip.signer!);
		expect(decodeFunctionResult({ abi: [f], data: result })).toBe(7n);
	});

	test("shutdown is idempotent", async () => {
		const ccip = serveEZCCIP(new EZCCIP(), { log: false });
		expect(ccip.shutdown()).toBe(ccip.shutdown());
		await ccip.shutdown();
		expect(fetch(ccip.endpoint)).rejects.toThrow();
	});
});
