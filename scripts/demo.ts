// bun run scripts/demo.ts

import { keccak256, stringToBytes } from "viem";
import pkg from "../package.json" with { type: "json" };
import { COIN_TYPE_DEFAULT, EZCCIP } from "../src/index.js";
import { serveEZCCIP } from "../src/serve.js";

const ezccip = new EZCCIP({
	// public demo key from its preimage, like the original serve(): do not use in production
	// key:     0x836df63ac213d059562eff5345da93d2049c9d4a07942d3476e42891fa3713c8
	// address: 0x24c8D99852e8174CD990d0Cc0A5627232F74FeD9
	signer: keccak256(stringToBytes("ezccip")),
	protocol: "tor",
});

ezccip.addFunctionHandler("function example(uint256 a, uint256 b) returns (uint256)", ([a, b]) => [a * 1000n + b]);

ezccip.enableENSIP10({
	resolve(name, ctx) {
		if (name === "__dne") return; // unreachable
		return {
			addr(coinType) {
				switch (coinType) {
					case COIN_TYPE_DEFAULT:
						return "0x51050ec063d393217b436747617ad1c2285aeeee";
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

const ccip = await serveEZCCIP(ezccip, { port: 8016 });
process.on("SIGINT", () => ccip.shutdown().then(() => process.exit()));
