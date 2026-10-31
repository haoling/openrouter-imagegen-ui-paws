import { unpack } from "msgpackr";

const ChunkTypes = ["start", "image", "error", "end", "alive", "usage"],
	MaxFrameLength = 64 * 1024 * 1024;

class FrameParser {
	constructor() {
		this.header = new Uint8Array(5);
		this.headerUsed = 0;
		this.payload = null;
		this.payloadUsed = 0;
	}

	async push(bytes, callback, signal) {
		let offset = 0;

		while (offset < bytes.length) {
			signal?.throwIfAborted();

			if (this.headerUsed < 5) {
				const length = Math.min(5 - this.headerUsed, bytes.length - offset);

				this.header.set(bytes.subarray(offset, offset + length), this.headerUsed);
				this.headerUsed += length;

				offset += length;

				if (this.headerUsed < 5) {
					continue;
				}

				const size = new DataView(this.header.buffer).getUint32(1, true);

				if (!ChunkTypes[this.header[0]] || size > MaxFrameLength) {
					throw new Error("Invalid stream frame header");
				}

				this.payload = new Uint8Array(size);
			}

			const length = Math.min(this.payload.length - this.payloadUsed, bytes.length - offset);

			this.payload.set(bytes.subarray(offset, offset + length), this.payloadUsed);
			this.payloadUsed += length;

			offset += length;

			if (this.payloadUsed === this.payload.length) {
				const type = ChunkTypes[this.header[0]],
					data = this.payload.length ? unpack(this.payload) : null;

				this.headerUsed = 0;
				this.payloadUsed = 0;
				this.payload = null;

				if (type !== "alive") {
					await callback({
						type: type,
						data: data
					});
				}
			}
		}
	}

	finish() {
		if (this.headerUsed || this.payload) {
			throw new Error("Truncated image stream");
		}
	}
}

export async function stream(url, options, callback) {
	const signal = options.signal,
		response = await fetch(url, options);

	// Request bodies may contain transient base64. Do not retain them while reading the response.
	options = null;

	if (!response.ok) {
		const error = await response.json().catch(() => null);

		throw new Error(error?.error || response.statusText);
	}

	const reader = response.body.getReader(),
		parser = new FrameParser();

	let ended = false;

	try {
		while (true) {
			const { value, done } = await reader.read();

			if (done) {
				break;
			}

			await parser.push(value, async chunk => {
				if (ended) {
					throw new Error("Frame after stream end");
				}

				ended = chunk.type === "end";

				await callback(chunk);
			}, signal);
		}

		parser.finish();

		if (!ended) {
			throw new Error("Image stream ended without an end frame");
		}
	} finally {
		await reader.cancel().catch(() => {});

		reader.releaseLock();
	}
}
