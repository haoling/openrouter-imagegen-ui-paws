const Scopes = ["https://www.googleapis.com/auth/drive.appdata", "https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/drive.metadata.readonly"].join(" ");

let clientId = null,
	tokenClient = null,
	accessToken = null,
	tokenExpiresAt = 0,
	onChange = () => {};

function loadGis() {
	return new Promise((resolve, reject) => {
		if (window.google?.accounts?.oauth2) {
			resolve();

			return;
		}

		const script = document.createElement("script");

		script.src = "https://accounts.google.com/gsi/client";
		script.async = true;
		script.defer = true;

		script.onload = () => resolve();
		script.onerror = () => reject(new Error("failed to load Google Identity Services"));

		document.head.appendChild(script);
	});
}

export async function initGoogleDrive(id, changeCallback) {
	clientId = id || null;

	if (changeCallback) {
		onChange = changeCallback;
	}

	if (!clientId) {
		return;
	}

	await loadGis();

	tokenClient = google.accounts.oauth2.initTokenClient({
		client_id: clientId,
		scope: Scopes,
		callback: response => {
			if (response.error) {
				console.error("Google Drive auth error:", response);

				return;
			}

			accessToken = response.access_token;
			tokenExpiresAt = Date.now() + (response.expires_in - 60) * 1000;

			onChange(true);
		},
	});
}

export function isGoogleDriveAvailable() {
	return !!clientId;
}

export function isGoogleDriveConnected() {
	return !!accessToken && Date.now() < tokenExpiresAt;
}

export function connectGoogleDrive() {
	if (!tokenClient) {
		throw new Error("Google Drive is not configured");
	}

	tokenClient.requestAccessToken({ prompt: "consent" });
}

export function disconnectGoogleDrive() {
	if (accessToken && window.google?.accounts?.oauth2) {
		google.accounts.oauth2.revoke(accessToken, () => {});
	}

	accessToken = null;
	tokenExpiresAt = 0;

	onChange(false);
}

function requestToken(prompt) {
	return new Promise((resolve, reject) => {
		const previous = tokenClient.callback;

		tokenClient.callback = response => {
			tokenClient.callback = previous;

			if (response.error) {
				reject(new Error(response.error));

				return;
			}

			accessToken = response.access_token;
			tokenExpiresAt = Date.now() + (response.expires_in - 60) * 1000;

			onChange(true);

			resolve(accessToken);
		};

		tokenClient.requestAccessToken({ prompt: prompt });
	});
}

async function ensureToken() {
	if (isGoogleDriveConnected()) {
		return accessToken;
	}

	if (!tokenClient) {
		throw new Error("Google Drive is not configured");
	}

	return requestToken("");
}

async function driveFetch(url, options = {}) {
	const token = await ensureToken();

	const response = await fetch(url, {
		...options,
		headers: {
			...(options.headers || {}),
			Authorization: `Bearer ${token}`,
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");

		throw new Error(`Google Drive API error ${response.status}: ${body}`);
	}

	return response;
}

function multipartBody(boundary, metadata, content, contentType) {
	return `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` + `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n--${boundary}--`;
}

// hidden app-specific data area (appDataFolder)
export async function listAppDataFiles() {
	const response = await driveFetch("https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,modifiedTime)&pageSize=1000"),
		data = await response.json();

	return data.files || [];
}

export async function readAppDataFile(name) {
	const files = await listAppDataFiles(),
		file = files.find(f => f.name === name);

	if (!file) {
		return null;
	}

	const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`);

	return response.text();
}

export async function writeAppDataFile(name, content) {
	const files = await listAppDataFiles(),
		existing = files.find(f => f.name === name),
		boundary = `paws-${Math.random().toString(16).slice(2)}`,
		metadata = existing ? {} : { name: name, parents: ["appDataFolder"] },
		body = multipartBody(boundary, metadata, content, "text/plain; charset=UTF-8"),
		url = existing ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart` : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

	await driveFetch(url, {
		method: existing ? "PATCH" : "POST",
		headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
		body: body,
	});
}

// user's drive folders (read-only listing to let the user pick a folder)
export async function listFolders() {
	const query = encodeURIComponent("mimeType='application/vnd.google-apps.folder' and trashed=false"),
		response = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&orderBy=name&pageSize=1000&spaces=drive`),
		data = await response.json();

	return data.files || [];
}

// read/write access to the user-selected folder (drive.file scope)
export async function listFilesInFolder(folderId) {
	const query = encodeURIComponent(`'${folderId}' in parents and trashed=false`),
		response = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,modifiedTime)&pageSize=1000`),
		data = await response.json();

	return data.files || [];
}

export async function uploadFileToFolder(folderId, name, blob) {
	const boundary = `paws-${Math.random().toString(16).slice(2)}`,
		metadata = { name: name, parents: [folderId] },
		head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`,
		tail = `\r\n--${boundary}--`,
		body = new Blob([head, blob, tail]);

	await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
		method: "POST",
		headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
		body: body,
	});
}

export async function downloadFile(fileId) {
	const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);

	return response.blob();
}
