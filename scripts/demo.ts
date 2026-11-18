// bun run scripts/demo.ts (PORT=8016)

import pkg from "../package.json" with { type: "json" };
import { COIN_TYPE_DEFAULT, COIN_TYPE_ETH, EZCCIP } from "../src/index.js";
import { serveEZCCIP } from "../src/serve.js";

const ezccip = new EZCCIP({
	// public demo key: do not use in production
	// address: 0xd00d726b2aD6C81E894DC6B87BE6Ce9c5572D2cd
	signer: "0xbd1e630bd00f12f0810083ea3bd2be936ead3b2fa84d1bd6690c77da043e9e02",
	protocol: "tor",
});

ezccip.addFunctionHandler("function example(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a * 1000n + b]);

ezccip.enableENSIP10({
	resolve(name, ctx) {
		if (name === "__dne") return; // unreachable
		return {
			addr(coinType) {
				switch (coinType) {
					case COIN_TYPE_ETH:
						return "0x51050ec063d393217B436747617aD1C2285Aeeee";
					case COIN_TYPE_DEFAULT: // other EVM chains, unless set below
						return "0xEB4200f750335eFb67E726485445d302D64B1c8A";
					case COIN_TYPE_DEFAULT + 8453n: // Base
						return "0xb404Af9A235Be881335d8898B5B487dc9Cd5ed9D";
					case 0n:
						return "0x76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac"; // encoded $btc address: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa (Satoshi)
					case 3n:
						return "0x76a9149eb02ebe2f323494320f9b1153f07a2e0eff528588ac"; // encoded $doge address: DKcAMwyEq5rwe2nXUMBqVYZFSNneCg6iSL
				}
			},
			data(key) {
				switch (key) {
					case "short":
						return "0x1234";
					case "long":
						return crypto.getRandomValues(new Uint8Array(128)); // new every request
				}
			},
			text(key) {
				switch (key) {
					case "name":
						return `ezccip Demo for ${name} (v${pkg.version})`;
					case "notice":
						return new Date().toLocaleString();
					case "description":
						return `Connection from ${ctx.extra.ip}`; // from serveEZCCIP();
					case "avatar":
						return "https://raffy.xyz/ens.jpg";
					case "header":
						return "https://raffy.xyz/header.jpg";
					case "url":
						return "https://github.com/adraffy/ezccip.js";
					case "location":
						return `Protocol(${ctx.protocol}) Sender(${ctx.sender})`;
				}
			},
			pubkey: () => ({ x: 1n, y: 2n }),
			contenthash: () => "0xe301017012201687de19f1516b9e560ab8655faa678e3a023ebff43494ac06a36581aafc957e", // vitalik's blog
			ABI: () => ({ type: 0n, data: "0x" }),
		};
	},
});

const ccip = await serveEZCCIP(ezccip, {
	port: Number(process.env.PORT || 8016),
	// current TOR deployments sign for this origin, regardless of the URL
	parseOrigin: () => ({ origin: "0x7CE6Cf740075B5AF6b1681d67136B84431B43AbD" }),
});
process.on("SIGINT", () => ccip.shutdown().then(() => process.exit()));
