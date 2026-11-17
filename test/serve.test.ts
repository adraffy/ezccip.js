import { describe, expect, spyOn, test } from "bun:test";
import { decodeFunctionResult, encodeFunctionData, type Hex, parseAbiItem, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EZCCIP, verifyResponse } from "../src/index.js";
import { serveEZCCIP } from "../src/serve.js";

const SENDER = "0x0000000000000000000000000000000000000001";
const ORIGIN = "0x0000000000000000000000000000000000000002";
const f = parseAbiItem("function f(uint256 x) returns (uint256)");
const fail = parseAbiItem("function fail()");
const getOrigin = parseAbiItem("function getOrigin() returns (address)");

function post(url: string, data: Hex) {
	return fetch(url, { method: "POST", body: JSON.stringify({ sender: SENDER, data }) });
}

function make() {
	const ezccip = new EZCCIP();
	ezccip.addHandler(f, ([x]) => [x + 1n]);
	ezccip.addHandler(getOrigin, (_, ctx) => [ctx.origin]);
	ezccip.addHandler(fail, () => {
		throw new Error("chonk");
	});
	return ezccip;
}

describe("serveEZCCIP", () => {
	test("logging", async () => {
		const lines: string[] = [];
		using _ = spyOn(console, "log").mockImplementation((date, ...a) => {
			expect(date).toBeInstanceOf(Date);
			lines.push(a.map(String).join(" "));
		});
		const ccip = await serveEZCCIP(make());
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

	test("request conversion", async () => {
		await using ccip = await serveEZCCIP(make(), { log: false });
		// origin from path
		const res = await post(`${ccip.endpoint}/${ORIGIN}`, toFunctionSelector(getOrigin));
		expect(decodeFunctionResult({ abi: [getOrigin], data: ((await res.json()) as { data: Hex }).data })).toBe(ORIGIN);
		// GET
		const get = await fetch(`${ccip.endpoint}/${SENDER}/${toFunctionSelector(getOrigin)}.json`);
		expect(get.status).toBe(200);
		// CORS preflight
		const preflight = await fetch(ccip.endpoint, { method: "OPTIONS" });
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
		// bad JSON
		expect((await fetch(ccip.endpoint, { method: "POST", body: "{" })).status).toBe(400);
	});

	test("log: false", async () => {
		using spy = spyOn(console, "log");
		const ccip = await serveEZCCIP(make(), { log: false });
		await post(ccip.endpoint, encodeFunctionData({ abi: [f], args: [1n] }));
		await ccip.shutdown();
		expect(spy).not.toHaveBeenCalled();
	});

	test("record function + signer", async () => {
		const privateKey = generatePrivateKey();
		const { address } = privateKeyToAccount(privateKey);
		await using ccip = await serveEZCCIP(() => ({ text: () => "Raffy" }), {
			signer: privateKey,
			protocol: "tor",
			log: false,
		});
		expect(ccip.signer).toBe(address);
		expect(ccip.context).toBe(`${address} ${ccip.endpoint}`);
		expect(ccip.ezccip.protocol).toBe("tor");
		expect(ccip.ezccip.findHandler("resolve")).toBeDefined();
	});

	test("verify over http", async () => {
		const ezccip = new EZCCIP({ signer: generatePrivateKey() });
		ezccip.addHandler(f, ([x]) => [x]);
		await using ccip = await serveEZCCIP(ezccip, { log: false });
		const request = encodeFunctionData({ abi: [f], args: [7n] });
		const { data: response } = (await (await post(ccip.endpoint, request)).json()) as { data: Hex };
		const { result, signer } = await verifyResponse({ protocol: "ens", response, request, origin: SENDER });
		expect(signer).toBe(ccip.signer!);
		expect(decodeFunctionResult({ abi: [f], data: result })).toBe(7n);
	});

	test("shutdown is idempotent and closes keep-alive connections", async () => {
		const ccip = await serveEZCCIP(make(), { log: false });
		await post(ccip.endpoint, encodeFunctionData({ abi: [f], args: [1n] })); // leaves a keep-alive connection
		expect(ccip.shutdown()).toBe(ccip.shutdown());
		await ccip.shutdown();
		expect(ccip.server.listening).toBe(false);
		expect(fetch(ccip.endpoint)).rejects.toThrow();
	});

	test("port in use", async () => {
		await using a = await serveEZCCIP(make(), { log: false });
		expect(serveEZCCIP(make(), { port: a.port, log: false })).rejects.toThrow();
	});
});
