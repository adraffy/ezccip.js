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
	ezccip.addFunctionHandler(f, ([x]) => [x + 1n]);
	ezccip.addFunctionHandler(getOrigin, (_, ctx) => [ctx.origin]);
	ezccip.addFunctionHandler(fail, () => {
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

	test("parseOrigin", async () => {
		await using ccip = await serveEZCCIP(make(), {
			log: false,
			parseOrigin: (url) => (url.searchParams.get("o") as Hex | null) ?? undefined,
		});
		const originOf = async (path: string) => {
			const res = await post(`${ccip.endpoint}${path}`, toFunctionSelector(getOrigin));
			return decodeFunctionResult({ abi: [getOrigin], data: ((await res.json()) as { data: Hex }).data });
		};
		expect(await originOf(`/?o=${ORIGIN}`)).toBe(ORIGIN);
		expect(await originOf(`/${ORIGIN}`)).toBe(SENDER); // replaces the path heuristic
	});

	test("extra: ip and custom values", async () => {
		const ezccip = new EZCCIP();
		const who = ezccip.addFunctionHandler("function who() returns (string)", (_, ctx) => [
			`${ctx.extra.ip} ${ctx.extra.name}`,
		]);
		await using ccip = await serveEZCCIP(ezccip, { log: false, extra: { name: "chonk" } });
		const res = await post(ccip.endpoint, who.selector);
		const { data } = (await res.json()) as { data: Hex };
		expect(decodeFunctionResult({ abi: [who.abiFunction], data })).toMatch(/^\S+ chonk$/);
		const forwarded = await fetch(ccip.endpoint, {
			method: "POST",
			headers: { "x-forwarded-for": "1.2.3.4" },
			body: JSON.stringify({ sender: SENDER, data: who.selector }),
		});
		const { data: data2 } = (await forwarded.json()) as { data: Hex };
		expect(decodeFunctionResult({ abi: [who.abiFunction], data: data2 })).toBe("1.2.3.4 chonk");
	});

	test("errors", async () => {
		await using ccip = await serveEZCCIP(make(), { log: false });
		expect((await fetch(ccip.endpoint, { method: "PUT" })).status).toBe(405);
		expect((await fetch(ccip.endpoint, { method: "POST", body: "{" })).status).toBe(400);
		expect((await fetch(`${ccip.endpoint}/nope`)).status).toBe(400);
		const res = await post(ccip.endpoint, toFunctionSelector(fail));
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ message: "internal error" });
	});

	test("log: false", async () => {
		using spy = spyOn(console, "log");
		const ccip = await serveEZCCIP(make(), { log: false });
		await post(ccip.endpoint, encodeFunctionData({ abi: [f], args: [1n] }));
		await ccip.shutdown();
		expect(spy).not.toHaveBeenCalled();
	});

	test("cors: false", async () => {
		await using ccip = await serveEZCCIP(make(), { log: false, cors: false });
		expect((await fetch(ccip.endpoint, { method: "OPTIONS" })).status).toBe(405);
		const res = await post(ccip.endpoint, toFunctionSelector(getOrigin));
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("chained enableENSIP10 with options", async () => {
		await using ccip = await serveEZCCIP(new EZCCIP().enableENSIP10({ resolve: () => ({}), multicall: false }), {
			cors: false,
			log: false,
		});
		const text = parseAbiItem("function text(bytes32, string) returns (string)");
		const resolve = parseAbiItem("function resolve(bytes, bytes) returns (bytes)");
		const data = encodeFunctionData({
			abi: [resolve],
			args: ["0x00", encodeFunctionData({ abi: [text], args: [`0x${"0".repeat(64)}`, "k"] })],
		});
		const res = await post(ccip.endpoint, data);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
		const { data: answer } = (await res.json()) as { data: Hex };
		expect(decodeFunctionResult({ abi: [text], data: answer })).toBe(""); // {} is empty, not UnreachableName
	});

	test("resolve function: default signer", async () => {
		await using a = await serveEZCCIP(() => ({ text: () => "Raffy" }), { log: false });
		await using b = await serveEZCCIP(() => undefined, { log: false, signer: undefined });
		expect(a.ezccip.signerAddress).toBeDefined();
		expect(a.ezccip.signerAddress).not.toBe(b.ezccip.signerAddress); // random per server
		expect(a.ezccip.protocol).toBe("ens");
		expect(a.context).toBe(`${a.ezccip.signerAddress} ${a.endpoint}`);
		expect(a.ezccip.findHandler("resolve")).toBeDefined();
	});

	test("resolve function + signer", async () => {
		const privateKey = generatePrivateKey();
		const { address } = privateKeyToAccount(privateKey);
		await using ccip = await serveEZCCIP(() => ({ text: () => "Raffy" }), {
			signer: privateKey,
			protocol: "tor",
			log: false,
		});
		expect(ccip.ezccip.signerAddress).toBe(address);
		expect(ccip.context).toBe(`${address} ${ccip.endpoint}`);
		expect(ccip.ezccip.protocol).toBe("tor");
		expect(ccip.ezccip.findHandler("resolve")).toBeDefined();
	});

	test("verify over http", async () => {
		const ezccip = new EZCCIP({ signer: generatePrivateKey() });
		ezccip.addFunctionHandler(f, ([x]) => [x]);
		await using ccip = await serveEZCCIP(ezccip, { log: false });
		const request = encodeFunctionData({ abi: [f], args: [7n] });
		const { data: response } = (await (await post(ccip.endpoint, request)).json()) as { data: Hex };
		const { result } = await verifyResponse({
			protocol: "ens",
			response,
			calldata: request,
			origin: SENDER,
			signer: ccip.ezccip.signerAddress,
		});
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

	test("request too large", async () => {
		await using ccip = await serveEZCCIP(make(), { log: false });
		const res = await fetch(ccip.endpoint, { method: "POST", body: "x".repeat((1 << 20) + 1) });
		expect(res.status).toBe(413);
	});

	test("port in use", async () => {
		await using a = await serveEZCCIP(make(), { log: false });
		expect(serveEZCCIP(make(), { port: a.port, log: false })).rejects.toThrow();
	});
});
