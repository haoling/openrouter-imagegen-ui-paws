import { transformBlob } from "./image-transform.js";

self.onmessage = async event => {
	try {
		const result = await transformBlob(event.data.blob, event.data.options);

		self.postMessage({
			result: result
		});
	} catch (error) {
		self.postMessage({
			error: error.message
		});
	}
};
