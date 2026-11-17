// bun run scripts/demo.ts

import pkg from "../package.json" with { type: "json" };
import { COIN_TYPE_DEFAULT, EZCCIP } from "../src/index.js";
import { serveEZCCIP } from "../src/serve.js";

const ezccip = new EZCCIP({
	// demo key: do not use in production
	signer: "0xbd1e630bd00f12f0810083ea3bd2be936ead3b2fa84d1bd6690c77da043e9e02",
	protocol: "tor",
});

const DNSTORWithENSProtocol = "0x3CA097Edd180Ea2C2436BD30c021Ca20869087a0";

ezccip.register("function example(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a * 1000n + b]);

ezccip.enableENSIP10((name, context) => {
	if (context.origin === DNSTORWithENSProtocol) {
		context.protocol = "ens"; // dynamic protocol change
	}
	if (name === "__dne") return; // unreachable
	return {
		addr(coinType) {
			switch (coinType) {
				case COIN_TYPE_DEFAULT:
					return "0x51050ec063d393217b436747617ad1c2285aeeee";
				case 3n:
					return "0x76a9149eb02ebe2f323494320f9b1153f07a2e0eff528588ac"; // encoded $doge address
			}
		},
		data(key) {
			if (key === "test") return "0x1234";
		},
		text(key) {
			switch (key) {
				case "name":
					return `ezccip Demo for ${name} (v${pkg.version})`;
				case "notice":
					return new Date().toLocaleString();
				case "description":
					return `Connection from ${context.request?.headers.get("user-agent")}`;
				case "avatar":
					return "https://raffy.xyz/ens.jpg";
				case "url":
					return "https://github.com/namestonehq/ezccip.js";
				case "location":
					return `Protocol(${context.protocol}) Sender(${context.sender})`;
			}
		},
		pubkey: () => ({ x: 1n, y: 2n }),
		contenthash: () => "0xe301017012201687de19f1516b9e560ab8655faa678e3a023ebff43494ac06a36581aafc957e", // vitalik's blog
		ABI: () => ({ type: 0n, data: "0x" }),
	};
});

const ccip = serveEZCCIP(ezccip, { port: 8016 });
process.on("SIGINT", () => ccip.shutdown().then(() => process.exit()));
