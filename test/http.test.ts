import { afterAll, describe, expect, spyOn, test } from "bun:test";
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
import {
	CCIPReadError,
	createFetchHandler,
	EZCCIP,
	originFromPath,
	parseCCIPReadBody,
	parseCCIPReadPath,
	parseCCIPReadRequest,
} from "../src/index.js";

const SENDER = "0x0000000000000000000000000000000000000001";
const ORIGIN = "0x0000000000000000000000000000000000000002";

const getOrigin = parseAbiItem("function getOrigin() returns (address)");
const fail = parseAbiItem("function fail()");
const failPublic = parseAbiItem("function failPublic()");
const GET_ORIGIN = toFunctionSelector(getOrigin);

function make() {
	const ezccip = new EZCCIP();
	ezccip.addFunctionHandler(getOrigin, (_, ctx) => [ctx.origin]);
	ezccip.addFunctionHandler(fail, () => {
		throw new Error("secret");
	});
	ezccip.addFunctionHandler(failPublic, () => {
		throw new CCIPReadError("chonk", { status: 418 });
	});
	return ezccip;
}

function post(
	fetch: (request: Request) => Promise<Response>,
	path = "/",
	body: unknown = { sender: SENDER, data: GET_ORIGIN },
) {
	return fetch(new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }));
}

async function originOf(res: Response) {
	expect(res.status).toBe(200);
	const { data } = (await res.json()) as { data: Hex };
	return decodeFunctionResult({ abi: [getOrigin], data });
}

describe("parsing", () => {
	test("parseCCIPReadPath", () => {
		expect(parseCCIPReadPath(`/a/${SENDER}/0x12.json`)).toEqual({ sender: SENDER, data: "0x12" });
		expect(parseCCIPReadPath(`/${SENDER}/0x12`)).toEqual({ sender: SENDER, data: "0x12" });
		expect(() => parseCCIPReadPath("/")).toThrow(CCIPReadError);
	});
	test("parseCCIPReadBody", () => {
		expect(parseCCIPReadBody(JSON.stringify({ sender: SENDER, data: "0x12" }))).toEqual({
			sender: SENDER,
			data: "0x12",
		});
		expect(() => parseCCIPReadBody("{")).toThrow("expected JSON");
		expect(() => parseCCIPReadBody("{}")).toThrow("expected {sender, data}");
		expect(() => parseCCIPReadBody("null")).toThrow("expected {sender, data}");
	});
	test("parseCCIPReadRequest", async () => {
		const body = JSON.stringify({ sender: SENDER, data: "0x12" });
		const expected = { sender: SENDER, data: "0x12" } as const;
		expect(await parseCCIPReadRequest(new Request("http://localhost/", { method: "POST", body }))).toEqual(expected);
		expect(await parseCCIPReadRequest(new Request(`http://localhost/${SENDER}/0x12.json`))).toEqual(expected);
		const put = parseCCIPReadRequest(new Request("http://localhost/", { method: "PUT" }));
		expect(put).rejects.toMatchObject({ status: 405 });
	});
	test("originFromPath", () => {
		expect(originFromPath(`/${ORIGIN}`)).toBe(ORIGIN);
		expect(originFromPath(`/a/${ORIGIN.toUpperCase().replace("0X", "0x")}/b`)).toBe(ORIGIN);
		expect(originFromPath(`/${ORIGIN}00`)).toBeUndefined();
		expect(originFromPath("/")).toBeUndefined();
	});
});

describe("createFetchHandler", () => {
	const fetch = createFetchHandler(make());

	describe("origin", () => {
		test("defaults to sender", async () => expect(await originOf(await post(fetch))).toBe(SENDER));
		for (const path of [`/${ORIGIN}`, `/${ORIGIN}/`, `/a/${ORIGIN}/b`, `/a/${ORIGIN}?x=1`]) {
			test(path, async () => expect(await originOf(await post(fetch, path))).toBe(ORIGIN));
		}
		test("parseOrigin replaces the path", async () => {
			const fetch = createFetchHandler(make(), {
				parseOrigin: (url) => (url.searchParams.get("o") as Hex | null) ?? undefined,
			});
			expect(await originOf(await post(fetch, `/?o=${ORIGIN}`))).toBe(ORIGIN);
			expect(await originOf(await post(fetch, `/${ORIGIN}`))).toBe(SENDER);
		});
		test("GET", async () => {
			const get = (path: string) => fetch(new Request(`http://localhost${path}`));
			expect(await originOf(await get(`/${SENDER}/${GET_ORIGIN}.json`))).toBe(SENDER);
			expect(await originOf(await get(`/${ORIGIN}/${SENDER}/${GET_ORIGIN}`))).toBe(ORIGIN);
		});
	});

	describe("errors", () => {
		test("handler error is hidden", async () => {
			const res = await post(fetch, "/", { sender: SENDER, data: toFunctionSelector(fail) });
			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({ message: "internal error" });
		});
		test("CCIPReadError is shown", async () => {
			const res = await post(fetch, "/", { sender: SENDER, data: toFunctionSelector(failPublic) });
			expect(res.status).toBe(418);
			expect(await res.json()).toEqual({ message: "chonk" });
		});
		test("bad request", async () => {
			expect((await post(fetch, "/", { sender: "0x", data: "0x12345678" })).status).toBe(400);
			expect((await fetch(new Request("http://localhost/", { method: "POST", body: "{" }))).status).toBe(400);
		});
		test("unknown function", async () => {
			expect((await post(fetch, "/", { sender: SENDER, data: "0x12345678" })).status).toBe(404);
		});
		test("method", async () => {
			expect((await fetch(new Request("http://localhost/", { method: "PUT" }))).status).toBe(405);
		});
	});

	test("CORS", async () => {
		const preflight = await fetch(new Request("http://localhost/", { method: "OPTIONS" }));
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
		expect((await post(fetch)).headers.get("access-control-allow-origin")).toBe("*");
	});

	test("cors: false", async () => {
		const fetch = createFetchHandler(make(), { cors: false });
		expect((await fetch(new Request("http://localhost/", { method: "OPTIONS" }))).status).toBe(405);
		const res = await post(fetch);
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("log", async () => {
		const lines: string[] = [];
		using _ = spyOn(console, "log").mockImplementation((_date, ...a) => {
			lines.push(a.map(String).join(" "));
		});
		const fetch = createFetchHandler(make(), { log: true });
		await post(fetch);
		await post(fetch, "/", { sender: SENDER, data: toFunctionSelector(fail) });
		expect(lines[0]).toMatch(/ \/ getOrigin\(\)$/);
		expect(lines[1]).toMatch(/ POST \/ 500 Error: secret/);
	});

	test("extra", async () => {
		const ezccip = new EZCCIP();
		const f = ezccip.addFunctionHandler("function f() returns (string)", (_, ctx) => [String(ctx.extra.NAME)]);
		const fetch = createFetchHandler(ezccip);
		const request = () =>
			new Request("http://localhost/", { method: "POST", body: JSON.stringify({ sender: SENDER, data: f.selector }) });
		const env = { NAME: "chonk" }; // eg. Cloudflare env
		const { data } = (await (await fetch(request(), env)).json()) as { data: Hex };
		expect(decodeFunctionResult({ abi: [f.abiFunction], data })).toBe("chonk");
		const { data: none } = (await (await fetch(request())).json()) as { data: Hex };
		expect(decodeFunctionResult({ abi: [f.abiFunction], data: none })).toBe("undefined");
	});

	test("throwing parseOrigin is a 500, not a crash", async () => {
		const fetch = createFetchHandler(make(), {
			parseOrigin: () => {
				throw new Error("bad");
			},
		});
		expect((await post(fetch)).status).toBe(500);
	});
});

describe("Bun.serve + viem ccipRequest", () => {
	const ezccip = new EZCCIP();
	ezccip.enableENSIP10({ resolve: (name, ctx) => ({ text: (key) => `${name}:${key}:${ctx.origin}` }) });
	const server = Bun.serve({ port: 0, fetch: createFetchHandler(ezccip) });
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
