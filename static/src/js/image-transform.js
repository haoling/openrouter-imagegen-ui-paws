export function adjustImageTones(context, width, height, brightness, contrast) {
	if (!brightness && !contrast) {
		return;
	}

	const image = context.getImageData(0, 0, width, height),
		pixels = image.data,
		curve = new Uint8Array(256),
		strength = 8 * Math.max(0, contrast) / 100,
		endpoint = Math.tanh(strength / 2),
		gamma = Math.pow(2, -brightness / 100);

	for (let value = 0; value < 256; value++) {
		const input = value / 255;

		let tone = input;

		if (contrast > 0) {
			tone = (Math.tanh((input - 0.5) * strength) / endpoint + 1) / 2;
		} else if (contrast < 0) {
			tone = 0.5 + (input - 0.5) * (1 + contrast / 100);
		}

		curve[value] = Math.round(255 * Math.pow(Math.min(1, Math.max(0, tone)), gamma));
	}

	for (let index = 0; index < pixels.length; index += 4) {
		pixels[index] = curve[pixels[index]];
		pixels[index + 1] = curve[pixels[index + 1]];
		pixels[index + 2] = curve[pixels[index + 2]];
	}

	context.putImageData(image, 0, 0);
}

export async function transformBlob(blob, options = {}) {
	const image = await decodeImage(blob);

	let canvas;

	try {
		if (options.inspect) {
			return { width: image.width, height: image.height };
		}

		const crop = options.crop,
			sourceX = Math.round((crop?.x || 0) * image.width),
			sourceY = Math.round((crop?.y || 0) * image.height),
			sourceWidth = Math.max(1, Math.round((crop?.width || 1) * image.width)),
			sourceHeight = Math.max(1, Math.round((crop?.height || 1) * image.height)),
			scale = options.max > 0 ? Math.min(1, options.max / Math.max(sourceWidth, sourceHeight)) : 1,
			width = Math.max(1, Math.round(sourceWidth * scale)),
			height = Math.max(1, Math.round(sourceHeight * scale));

		canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;

		const context = canvas.getContext("2d", { willReadFrequently: Boolean(options.brightness || options.contrast) });

		context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);

		adjustImageTones(context, width, height, options.brightness, options.contrast);

		const result = await encodeCanvas(canvas, options.format || "image/png");

		return {
			blob: result,
			width: width,
			height: height
		};
	} finally {
		image.close?.();

		if (canvas) {
			canvas.width = 1;
			canvas.height = 1;
		}
	}
}

async function decodeImage(blob) {
	if (typeof createImageBitmap === "function") {
		try {
			return await createImageBitmap(blob);
		} catch (error) {
			if (typeof Image !== "function") {
				throw error;
			}
		}
	}

	const image = new Image(),
		url = URL.createObjectURL(blob);

	try {
		image.src = url;

		await image.decode();

		return image;
	} finally {
		URL.revokeObjectURL(url);
	}
}

function encodeCanvas(canvas, type) {
	if (canvas.convertToBlob) {
		return canvas.convertToBlob({
			type: type,
			quality: 0.92
		});
	}

	return new Promise((resolve, reject) => {
		canvas.toBlob(blob => {
			if (blob) {
				resolve(blob);
			} else {
				reject(new Error("Image encoding failed"));
			}
		}, type, 0.92);
	});
}
