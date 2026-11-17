import { afterAll, describe, expect, test } from "bun:test";
import {
	bytesToHex,
	ccipRequest,
	decodeFunctionResult,
	encodeFunctionData,
	type Hex,
	pad,
	parseAbiItem,
	toFunctionSelector,
} from "viem";
import { packetToBytes } from "viem/ens";
import { RESOLVE } from "../src/ens/abi.js";
import { EZCCIP, type EZCCIPOptions, originFromPath, parseCCIPReadRequest } from "../src/index.js";

const SENDER = "0x0000000000000000000000000000000000000001";
const ORIGIN = "0x0000000000000000000000000000000000000002";
const OTHER = "0x0000000000000000000000000000000000000003";

const getOrigin = parseAbiItem("function getOrigin() returns (address)");
const fail = parseAbiItem("function fail()");
const GET_ORIGIN = toFunctionSelector(getOrigin);
const FAIL = toFunctionSelector(fail);

function make(options?: EZCCIPOptions) {
	const ezccip = new EZCCIP(options);
	ezccip.addHandler(getOrigin, (_, ctx) => [ctx.origin]);
	ezccip.addHandler(fail, () => {
		throw new Error("chonk");
	});
	return ezccip;
}

function post(ezccip: EZCCIP, path = "/", body: unknown = { sender: SENDER, data: GET_ORIGIN }) {
	return ezccip.fetch(new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }));
}

async function originOf(res: Response) {
	expect(res.status).toBe(200);
	const { data } = (await res.json()) as { data: Hex };
	return decodeFunctionResult({ abi: [getOrigin], data });
}

describe("parseCCIPReadRequest", () => {
	test("POST", async () => {
		const request = new Request("http://localhost/a", {
			method: "POST",
			body: JSON.stringify({ sender: SENDER, data: "0x12" }),
		});
		expect(await parseCCIPReadRequest(request)).toEqual({ sender: SENDER, data: "0x12" });
	});
	test("GET", async () => {
		const request = new Request(`http://localhost/a/${SENDER}/0x12.json`);
		expect(await parseCCIPReadRequest(request)).toEqual({ sender: SENDER, data: "0x12" });
	});
	test("errors", async () => {
		const bad = (init: RequestInit, path = "/") => parseCCIPReadRequest(new Request(`http://localhost${path}`, init));
		expect(bad({ method: "POST", body: "{" })).rejects.toMatchObject({ status: 400 });
		expect(bad({ method: "POST", body: "{}" })).rejects.toMatchObject({ status: 400 });
		expect(bad({ method: "GET" })).rejects.toMatchObject({ status: 400 });
		expect(bad({ method: "PUT" })).rejects.toMatchObject({ status: 405 });
	});
});

test("originFromPath", () => {
	expect(originFromPath(`/${ORIGIN}`)).toBe(ORIGIN);
	expect(originFromPath(`/a/${ORIGIN.toUpperCase().replace("0X", "0x")}/b`)).toBe(ORIGIN);
	expect(originFromPath(`/${ORIGIN}00`)).toBeUndefined();
	expect(originFromPath("/")).toBeUndefined();
});

describe("origin", () => {
	test("default", async () => expect(await originOf(await post(make()))).toBe(SENDER));
	test("fallback", async () => expect(await originOf(await post(make({ origin: ORIGIN })))).toBe(ORIGIN));
	test("parseOrigin", async () => {
		const ezccip = make({ parseOrigin: (url) => (url.searchParams.get("o") as Hex | null) ?? undefined });
		expect(await originOf(await post(ezccip, `/?o=${ORIGIN}`))).toBe(ORIGIN);
		// replaces the path heuristic
		expect(await originOf(await post(ezccip, `/${OTHER}`))).toBe(SENDER);
	});
	test("parseOrigin falls back to origin option", async () => {
		const ezccip = make({ origin: OTHER, parseOrigin: () => undefined });
		expect(await originOf(await post(ezccip, `/${ORIGIN}`))).toBe(OTHER);
	});
	for (const path of [`/${ORIGIN}`, `/${ORIGIN}/`, `/a/${ORIGIN}/b`, `/a/${ORIGIN}?x=1`]) {
		test(path, async () => expect(await originOf(await post(make({ origin: OTHER }), path))).toBe(ORIGIN));
	}
});

describe("GET", () => {
	test("/{sender}/{data}.json", async () => {
		const res = await make().fetch(new Request(`http://localhost/${SENDER}/${GET_ORIGIN}.json`));
		expect(await originOf(res)).toBe(SENDER);
	});
	test("/{origin}/{sender}/{data}", async () => {
		const res = await make().fetch(new Request(`http://localhost/${ORIGIN}/${SENDER}/${GET_ORIGIN}`));
		expect(await originOf(res)).toBe(ORIGIN);
	});
});

describe("errors", () => {
	test("handler error", async () => {
		const res = await post(make(), "/", { sender: SENDER, data: FAIL });
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ message: "internal error" }); // not "chonk"
	});
	test("bad request", async () => {
		const res = await post(make(), "/", { sender: "0x", data: "0x12345678" });
		expect(res.status).toBe(400);
	});
	test("method", async () => {
		const res = await make().fetch(new Request("http://localhost/", { method: "PUT" }));
		expect(res.status).toBe(405);
	});
});

test("cors: false", async () => {
	const ezccip = make();
	const request = (method: string) =>
		new Request("http://localhost/", {
			method,
			body: method === "POST" ? JSON.stringify({ sender: SENDER, data: GET_ORIGIN }) : undefined,
		});
	const preflight = await ezccip.handleRequest(request("OPTIONS"), { cors: false });
	expect(preflight.status).toBe(405);
	const res = await ezccip.handleRequest(request("POST"), { cors: false });
	expect(res.status).toBe(200);
	expect(res.headers.get("access-control-allow-origin")).toBeNull();
});

test("CORS", async () => {
	const ezccip = make();
	const preflight = await ezccip.fetch(new Request("http://localhost/", { method: "OPTIONS" }));
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
	expect((await post(ezccip)).headers.get("access-control-allow-origin")).toBe("*");
});

describe("hooks", () => {
	test("instance", async () => {
		const events: string[] = [];
		const ezccip = make({
			onResponse: ({ url, context, data }) => events.push(`ok ${url.pathname} ${context.history} ${data.length}`),
			onError: ({ status, error }) => events.push(`error ${status} ${(error as Error).message}`),
		});
		await post(ezccip, `/${ORIGIN}`);
		await post(ezccip, "/", { sender: SENDER, data: FAIL });
		await post(ezccip, "/", { sender: "0x", data: "0x" });
		expect(events).toEqual([`ok /${ORIGIN} getOrigin() 66`, "error 500 chonk", "error 400 expected sender address"]);
	});
	test("instance + per request", async () => {
		const events: string[] = [];
		const ezccip = make({ onResponse: () => events.push("instance") });
		const request = new Request("http://localhost/", {
			method: "POST",
			body: JSON.stringify({ sender: SENDER, data: GET_ORIGIN }),
		});
		await ezccip.handleRequest(request, { onResponse: () => events.push("request") });
		expect(events).toEqual(["instance", "request"]);
	});
	test("onError has context", async () => {
		let history = "";
		const ezccip = make({ onError: ({ context }) => (history = String(context?.history)) });
		await post(ezccip, "/", { sender: SENDER, data: FAIL });
		expect(history).toBe("fail()<chonk>");
	});
	test("rejecting async hook is ignored", async () => {
		const ezccip = make({
			onResponse: async () => {
				throw new Error("bad hook");
			},
		});
		expect(await originOf(await post(ezccip))).toBe(SENDER);
		await new Promise((resolve) => setTimeout(resolve, 10)); // let a rejection surface
	});
	test("throwing hook is ignored", async () => {
		const ezccip = make({
			onResponse: () => {
				throw new Error("bad hook");
			},
		});
		expect(await originOf(await post(ezccip))).toBe(SENDER);
	});
});

test("extra context", async () => {
	const ezccip = new EZCCIP<{ env: { name: string } }>();
	const fn = ezccip.addHandler("function f() returns (string)", (_, __, extra) => [extra.env.name]);
	const request = new Request("http://localhost/", {
		method: "POST",
		body: JSON.stringify({ sender: SENDER, data: fn.selector }),
	});
	const res = await ezccip.handleRequest(request, { extra: { env: { name: "chonk" } } });
	const { data } = (await res.json()) as { data: Hex };
	expect(decodeFunctionResult({ abi: [fn.abiFunction], data })).toBe("chonk");
});

describe("Bun.serve + viem ccipRequest", () => {
	const ezccip = new EZCCIP();
	ezccip.enableENSIP10({ resolve: (name, ctx) => ({ text: (key) => `${name}:${key}:${ctx.origin}` }) });
	const server = Bun.serve({ port: 0, fetch: ezccip.fetch });
	afterAll(() => server.stop(true));

	const text = parseAbiItem("function text(bytes32, string) returns (string)");
	const data = encodeFunctionData({
		abi: [RESOLVE],
		args: [bytesToHex(packetToBytes("raffy.eth")), encodeFunctionData({ abi: [text], args: [pad("0x"), "name"] })],
	});

	for (const [method, template] of [
		["POST", ORIGIN],
		["GET", `${ORIGIN}/{sender}/{data}.json`],
	]) {
		test(method!, async () => {
			const res = await ccipRequest({ sender: SENDER, data, urls: [`${server.url}${template}`] });
			expect(decodeFunctionResult({ abi: [text], data: res })).toBe(`raffy.eth:name:${ORIGIN}`);
		});
	}
});
