// Smoke test of the built package (dist/) on any runtime: node scripts/smoke.mjs
import assert from "node:assert/strict";
import { decodeFunctionResult, encodeFunctionData, parseAbiItem } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { EZCCIP, verifyResponse } from "../dist/index.js";
import { serveEZCCIP } from "../dist/serve.js";

const sender = "0x0000000000000000000000000000000000000001";
const fn = parseAbiItem("function plus(uint256 a, uint256 b) returns (uint256)");
const ezccip = new EZCCIP({ signer: generatePrivateKey(), protocol: "tor" });
ezccip.addFunctionHandler(fn, ([a, b]) => [a + b]);

const ccip = await serveEZCCIP(ezccip, { log: false });
try {
	const calldata = encodeFunctionData({ abi: [fn], args: [1n, 2n] });
	for (const [method, url, body] of [
		["POST", ccip.endpoint, JSON.stringify({ sender, data: calldata })],
		["GET", `${ccip.endpoint}/${sender}/${calldata}.json`],
	]) {
		const res = await fetch(url, { method, body });
		assert.equal(res.status, 200, method);
		const { data: response } = await res.json();
		const { result } = await verifyResponse({
			protocol: "tor",
			response,
			calldata,
			origin: sender,
			signer: ezccip.signerAddress,
		});
		assert.equal(decodeFunctionResult({ abi: [fn], data: result }), 3n, method);
	}
	console.log(`smoke ok (${typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`})`);
} finally {
	await ccip.shutdown();
}
