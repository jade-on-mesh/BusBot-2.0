// Adds a hashtag channel (e.g. #transit) to a companion radio over USB serial.
// Useful when the radio is plugged into a Pi and the phone app can't reach it.
// Stop whatever bot is using the port first.
//
//   npx tsx scripts/add_channel.ts /dev/serial/by-id/usb-... "#transit"
//
// Hashtag channel keys are the first 16 bytes of sha256(channel name), so
// every radio that adds "#transit" ends up on the same channel.
import { createHash } from "node:crypto";
import { NodeJSSerialConnection } from "@liamcottle/meshcore.js";

const [port, rawName] = process.argv.slice(2);
if (!port || !rawName) {
	console.error('Usage: npx tsx scripts/add_channel.ts <serial port> "#channel"');
	process.exit(1);
}
const name = rawName.startsWith("#") ? rawName.toLowerCase() : `#${rawName.toLowerCase()}`;
const secret = new Uint8Array(createHash("sha256").update(name).digest().subarray(0, 16));

const connection = new NodeJSSerialConnection(port);
const fail = (msg: string) => {
	console.error(msg);
	process.exit(1);
};
setTimeout(() => fail("Timed out talking to the radio. Is another program using the port?"), 30_000).unref();

connection.on("connected", async () => {
	try {
		const channels: any[] = await connection.getChannels();
		for (const c of channels) console.log(`  slot ${c.channelIdx}: ${c.name || "(empty)"}`);

		const existing = channels.find((c) => c.name?.toLowerCase() === name);
		if (existing) {
			console.log(`${name} is already on the radio in slot ${existing.channelIdx}. Nothing to do.`);
			process.exit(0);
		}
		const free = channels.find((c) => c.channelIdx > 0 && !c.name);
		if (!free) fail("No empty channel slot on this radio. Remove a channel first.");

		await connection.setChannel(free.channelIdx, name, secret);
		console.log(`Added ${name} in slot ${free.channelIdx}.`);
		process.exit(0);
	} catch (e) {
		fail(`Failed: ${e}`);
	}
});

await connection.connect();
