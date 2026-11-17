import { afterAll, describe, expect, test } from "bun:test";
import { AbiFunction, AbiParameters, Hex } from "ox";
import { ccipRequest } from "viem";
import { dnsEncode, EZCCIP, RESOLVE_ABI } from "../src/index.ts";

const SENDER = "0x0000000000000000000000000000000000000001";
const ORIGIN = "0x0000000000000000000000000000000000000002";
const OTHER = "0x0000000000000000000000000000000000000003";

const getOrigin = AbiFunction.from("function getOrigin() returns (address)");
const fail = AbiFunction.from("function fail()");

function make(options?: ConstructorParameters<typeof EZCCIP>[0]) {
	const ezccip = new EZCCIP(options);
	ezccip.register(getOrigin, (_, context) => [context.origin]);
	ezccip.register(fail, () => {
		throw new Error("chonk");
	});
	return ezccip;
}

function post(ezccip: EZCCIP, path = "/", body: unknown = { sender: SENDER, data: AbiFunction.encodeData(getOrigin) }) {
	return ezccip.fetch(
		new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) })
	);
}

async function originOf(res: Response) {
	expect(res.status).toBe(200);
	const { data } = (await res.json()) as { data: Hex.Hex };
	return AbiFunction.decodeResult(getOrigin, data);
}

describe("origin", () => {
	test("default", async () => expect(await originOf(await post(make()))).toBe(SENDER));
	test("fallback", async () => expect(await originOf(await post(make({ origin: ORIGIN })))).toBe(ORIGIN));
	test("parseOrigin", async () => {
		const ezccip = make({ parseOrigin: (url) => (url.searchParams.get("o") as Hex.Hex) ?? undefined });
		expect(await originOf(await post(ezccip, `/?o=${ORIGIN}`))).toBe(ORIGIN);
	});
	for (const path of [`/${ORIGIN}`, `/${ORIGIN}/`, `/a/${ORIGIN}/b`, `/a/${ORIGIN}?x=1`]) {
		test(path, async () => expect(await originOf(await post(make({ origin: OTHER }), path))).toBe(ORIGIN));
	}
	test("not a path component", async () => {
		expect(await originOf(await post(make(), `/${ORIGIN}00`))).toBe(SENDER);
	});
});

describe("GET", () => {
	const data = AbiFunction.encodeData(getOrigin);
	test("/{sender}/{data}.json", async () => {
		const res = await make().fetch(new Request(`http://localhost/${SENDER}/${data}.json`));
		expect(await originOf(res)).toBe(SENDER);
	});
	test("/{origin}/{sender}/{data}", async () => {
		const res = await make().fetch(new Request(`http://localhost/${ORIGIN}/${SENDER}/${data}`));
		expect(await originOf(res)).toBe(ORIGIN);
	});
	test("bad path", async () => {
		const res = await make().fetch(new Request("http://localhost/"));
		expect(res.status).toBe(400);
	});
});

describe("errors", () => {
	test("handler error", async () => {
		const res = await post(make(), "/", { sender: SENDER, data: AbiFunction.encodeData(fail) });
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ message: "chonk" });
	});
	test("bad json", async () => {
		const res = await make().fetch(new Request("http://localhost/", { method: "POST", body: "{" }));
		expect(res.status).toBe(400);
	});
	test("bad sender", async () => {
		const res = await post(make(), "/", { sender: "0x", data: "0x12345678" });
		expect(res.status).toBe(400);
	});
	test("method", async () => {
		const res = await make().fetch(new Request("http://localhost/", { method: "PUT" }));
		expect(res.status).toBe(405);
	});
});

test("CORS", async () => {
	const ezccip = make();
	const preflight = await ezccip.fetch(new Request("http://localhost/", { method: "OPTIONS" }));
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
	expect((await post(ezccip)).headers.get("access-control-allow-origin")).toBe("*");
});

test("log", async () => {
	const lines: unknown[][] = [];
	const ezccip = make({ log: (...a) => lines.push(a) });
	await post(ezccip);
	await post(ezccip, "/", { sender: SENDER, data: AbiFunction.encodeData(fail) });
	expect(lines).toHaveLength(2);
	expect(lines[0]).toEqual(["/", "getOrigin()"]);
	expect(lines[1]?.[0]).toBe("POST");
});

test("extra context via handleRequest", async () => {
	const ezccip = new EZCCIP<{ env: { name: string } }>();
	ezccip.register("function f() returns (string)", (_, context) => [context.env.name]);
	const res = await ezccip.handleRequest(
		new Request("http://localhost/", {
			method: "POST",
			body: JSON.stringify({ sender: SENDER, data: AbiFunction.getSelector("function f()") }),
		}),
		{ env: { name: "chonk" } }
	);
	const { data } = (await res.json()) as { data: Hex.Hex };
	expect(AbiParameters.decode(AbiParameters.from(["string"]), data)).toEqual(["chonk"]);
});

describe("Bun.serve + viem ccipRequest", () => {
	const ezccip = new EZCCIP();
	ezccip.enableENSIP10((name, context) => ({
		text: (key) => `${name}:${key}:${context.origin}`,
	}));
	const server = Bun.serve({ port: 0, fetch: ezccip.fetch });
	afterAll(() => server.stop(true));

	const resolve = AbiFunction.fromAbi(RESOLVE_ABI, "resolve");
	const text = AbiFunction.from("function text(bytes32, string) returns (string)");
	const data = AbiFunction.encodeData(resolve, [
		dnsEncode("raffy.eth"),
		AbiFunction.encodeData(text, [Hex.padLeft("0x", 32), "name"]),
	]);

	test("POST", async () => {
		const res = await ccipRequest({ sender: SENDER, data, urls: [`${server.url}${ORIGIN}`] });
		expect(AbiFunction.decodeResult(text, res)).toBe(`raffy.eth:name:${ORIGIN}`);
	});
	test("GET", async () => {
		const res = await ccipRequest({
			sender: SENDER,
			data,
			urls: [`${server.url}${ORIGIN}/{sender}/{data}.json`],
		});
		expect(AbiFunction.decodeResult(text, res)).toBe(`raffy.eth:name:${ORIGIN}`);
	});
});
