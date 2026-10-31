import { transformBlob } from "./image-transform.js";

const MaxConcurrentTasks = 2,
	WorkerSupported = typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function";

const queue = [],
	activeTasks = [],
	workers = [];

// Two decodes at a time bounds decoded-pixel memory, including the fallback.
export function processBlob(blob, options = {}, signal) {
	return new Promise((resolve, reject) => {
		const task = {
			blob: blob,
			options: options,
			signal: signal,
			resolve: resolve,
			reject: reject,
		};

		task.abortQueued = () => {
			const index = queue.indexOf(task);

			if (index !== -1) {
				queue.splice(index, 1);

				reject(new DOMException("Aborted", "AbortError"));
			}
		};

		signal?.addEventListener("abort", task.abortQueued, { once: true });

		queue.push(task);

		pump();
	});
}

function pump() {
	while (activeTasks.length < MaxConcurrentTasks && queue.length) {
		const task = queue.shift();

		task.signal?.removeEventListener("abort", task.abortQueued);

		if (task.signal?.aborted) {
			task.reject(new DOMException("Aborted", "AbortError"));

			continue;
		}

		activeTasks.push(task);

		run(task).catch(async error => {
			if (error.name === "AbortError" || task.signal?.aborted || !WorkerSupported) {
				throw error;
			}

			// Partial worker/bitmap implementations (notably SVG decoding) still work on the main thread.
			const result = await transformBlob(task.blob, task.options);

			task.signal?.throwIfAborted();

			return result;
		}).then(task.resolve, task.reject).finally(() => {
			activeTasks.splice(activeTasks.indexOf(task), 1);

			pump();
		});
	}
}

async function run(task) {
	let result;

	if (WorkerSupported) {
		const worker = workers.pop() || new Worker(new URL("./image-worker.js", import.meta.url), { type: "module" });

		let abort,
			completed = false;

		try {
			result = await new Promise((resolve, reject) => {
				abort = () => reject(new DOMException("Aborted", "AbortError"));

				task.signal?.addEventListener("abort", abort, { once: true });

				worker.onmessage = event => {
					if (event.data.error) {
						reject(new Error(event.data.error));
					} else {
						resolve(event.data.result);
					}
				};

				worker.onerror = event => reject(new Error(event.message));

				worker.postMessage({
					blob: task.blob,
					options: task.options
				});
			});

			completed = true;
		} finally {
			task.signal?.removeEventListener("abort", abort);

			worker.onmessage = null;
			worker.onerror = null;

			if (completed) {
				workers.push(worker);
			} else {
				// Termination also releases an obsolete operation's bitmap and canvas.
				worker.terminate();
			}
		}
	} else {
		result = await transformBlob(task.blob, task.options);
	}

	task.signal?.throwIfAborted();

	return result;
}
