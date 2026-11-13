import { google } from 'googleapis';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
interface OAuthSecret {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export function parseOAuthSecret(raw: string | undefined): OAuthSecret {
  let parsed: Partial<OAuthSecret> | null;
  try {
    parsed = JSON.parse(raw ?? '') as Partial<OAuthSecret> | null;
  } catch {
    throw new Error('Missing or invalid GOOGLE_DRIVE_OAUTH_JSON.');
  }
  if (!parsed || ['client_id', 'client_secret', 'refresh_token'].some(
    (key) => typeof parsed[key as keyof OAuthSecret] !== 'string'
      || !parsed[key as keyof OAuthSecret]?.trim(),
  )) {
    throw new Error('OAuth JSON must contain client_id, client_secret and refresh_token.');
  }
  return parsed as OAuthSecret;
}

export function validateScopes(scopes: string[]): void {
  if (scopes.length !== 1 || scopes[0] !== DRIVE_FILE_SCOPE) {
    console.error('Use a refresh token authorized ONLY for drive.file; other scopes are rejected.');
    throw new Error('Unexpected OAuth scopes.');
  }
}

export async function authorizeDrive() {
  const secret = parseOAuthSecret(process.env.GOOGLE_DRIVE_OAUTH_JSON);
  const auth = new google.auth.OAuth2(secret.client_id, secret.client_secret);
  auth.setCredentials({ refresh_token: secret.refresh_token });
  const token = (await auth.getAccessToken()).token;
  if (!token) throw new Error('OAuth returned no access token.');
  validateScopes((await auth.getTokenInfo(token)).scopes);
  // Verify that Drive API is enabled, without creating files or reading unrelated data.
  const drive = google.drive({ version: 'v3', auth });
  await drive.files.list({
    q: "trashed = false and appProperties has { key='updaterRoot' and value='nl-eu-public-updater-root-v1' }",
    pageSize: 1,
    fields: 'files(id)',
  });
  console.log('OAuth refresh and Drive API access verified; scope: drive.file.');
  return auth;
}

if (process.argv.includes('--check-auth')) {
  authorizeDrive().catch((error) => {
    // Never print Google errors: their request bodies can contain credentials.
    const status = error?.response?.status;
    console.error('OAuth/Drive preflight failed' +
      (typeof status === 'number' && Number.isInteger(status) ? ` (HTTP ${status})` : '') +
      '. Check the repository OAuth secret, drive.file scope and Drive API activation.');
    process.exitCode = 1;
  });
}
