/**
 * nestmatch/src/googleDrive.js
 *
 * Handles Google OAuth2 (PKCE flow — safe for pure frontend / GitHub Pages)
 * and uploads the Excel file to a "NestMatch" folder in the user's Drive.
 *
 * HOW TO SET UP OAUTH CREDENTIALS
 * ─────────────────────────────────
 * 1. Go to https://console.cloud.google.com/
 * 2. Create a project (or pick an existing one)
 * 3. Enable APIs:  Google Drive API
 * 4. Credentials → Create credentials → OAuth 2.0 Client ID
 *    • Application type: Web application
 *    • Authorised JavaScript origins:
 *        http://localhost:3000
 *        https://YOUR_GITHUB_USERNAME.github.io
 *    • Authorised redirect URIs:
 *        http://localhost:3000
 *        https://YOUR_GITHUB_USERNAME.github.io/nestmatch
 * 5. Copy the Client ID into REACT_APP_GDRIVE_CLIENT_ID in your .env file
 * 6. OAuth consent screen → add your email as a test user (while in dev/testing)
 */

const CLIENT_ID     = process.env.REACT_APP_GDRIVE_CLIENT_ID || "";
const REDIRECT_URI  = window.location.origin + window.location.pathname.replace(/\/$/, "");
const SCOPES        = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME   = "NestMatch";
const TOKEN_KEY     = "nestmatch_gdrive_token";

// ── PKCE helpers ─────────────────────────────────────────────────────────────
function randomBase64(len) {
  const arr = new Uint8Array(len);
  window.crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function sha256Base64url(plain) {
  const enc = new TextEncoder().encode(plain);
  const hash = await window.crypto.subtle.digest("SHA-256", enc);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ── Token storage ─────────────────────────────────────────────────────────────
export function getStoredToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY));
    if (t && t.expires_at > Date.now()) return t;
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  } catch { return null; }
}

function storeToken(token) {
  const t = {
    ...token,
    expires_at: Date.now() + (token.expires_in - 60) * 1000,
  };
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t));
  return t;
}

// ── Auth: kick off PKCE OAuth2 flow ─────────────────────────────────────────
export async function startOAuthFlow() {
  if (!CLIENT_ID) {
    alert("Google OAuth Client ID is not configured.\nAdd REACT_APP_GDRIVE_CLIENT_ID to your .env file.");
    return;
  }
  const verifier  = randomBase64(64);
  const challenge = await sha256Base64url(verifier);
  sessionStorage.setItem("pkce_verifier", verifier);

  const params = new URLSearchParams({
    client_id:             CLIENT_ID,
    redirect_uri:          REDIRECT_URI,
    response_type:         "code",
    scope:                 SCOPES,
    code_challenge:        challenge,
    code_challenge_method: "S256",
    access_type:           "offline",
    prompt:                "consent",
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ── Token exchange (called on redirect back from Google) ─────────────────────
export async function handleOAuthCallback() {
  const params   = new URLSearchParams(window.location.search);
  const code     = params.get("code");
  const verifier = sessionStorage.getItem("pkce_verifier");
  if (!code || !verifier) return null;

  // Clean the URL
  window.history.replaceState({}, "", window.location.pathname);
  sessionStorage.removeItem("pkce_verifier");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      redirect_uri:  REDIRECT_URI,
      grant_type:    "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error("Token exchange failed: " + await res.text());
  return storeToken(await res.json());
}

// ── Drive API helpers ─────────────────────────────────────────────────────────
async function apiCall(url, options, token) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Drive API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function findOrCreateFolder(token) {
  // Search for existing NestMatch folder
  const q = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const search = await apiCall(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`,
    { method: "GET" },
    token
  );
  if (search.files?.length) return search.files[0].id;

  // Create it
  const folder = await apiCall(
    "https://www.googleapis.com/drive/v3/files",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
      }),
    },
    token
  );
  return folder.id;
}

async function findExistingFile(folderId, fileName, token) {
  const q = encodeURIComponent(
    `name='${fileName}' and '${folderId}' in parents and trashed=false`
  );
  const res = await apiCall(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`,
    { method: "GET" },
    token
  );
  return res.files?.[0]?.id || null;
}

// ── Main: upload / update the Excel file on Drive ────────────────────────────
export async function uploadToDrive(xlsxBlob, fileName = "nestmatch_data.xlsx") {
  const token = getStoredToken();
  if (!token) throw new Error("NOT_AUTHENTICATED");

  const folderId    = await findOrCreateFolder(token);
  const existingId  = await findExistingFile(folderId, fileName, token);

  const metadata = JSON.stringify(
    existingId
      ? {}                                               // update: no metadata needed
      : { name: fileName, parents: [folderId] }          // create: set name + parent
  );

  const form = new FormData();
  form.append("metadata", new Blob([metadata], { type: "application/json" }));
  form.append("file", xlsxBlob, fileName);

  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

  const method = existingId ? "PATCH" : "POST";

  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token.access_token}` },
    body: form,
  });
  if (!res.ok) throw new Error("Upload failed: " + await res.text());
  const file = await res.json();
  return `https://drive.google.com/file/d/${file.id}/view`;
}
