import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SignJWT, importPKCS8 } from 'jose';

const GITHUB_APP_ID = process.env.GITHUB_APP_ID!;
const PRIVATE_KEY_SECRET_ARN = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

const secretsManager = new SecretsManagerClient({ region: REGION });

// Cached across warm invocations — the PEM never changes between requests.
let cachedPrivateKeyPem: string | null = null;

async function getPrivateKeyPem(): Promise<string> {
  if (cachedPrivateKeyPem) return cachedPrivateKeyPem;
  const result = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: PRIVATE_KEY_SECRET_ARN }),
  );
  const pem = result.SecretString;
  if (!pem) throw new Error('GitHub App private key secret has no SecretString');
  cachedPrivateKeyPem = pem;
  return pem;
}

// A GitHub App JWT is only used to authenticate the installation-token exchange
// below; it's valid for at most 10 minutes per GitHub's docs and is never
// returned to the caller.
async function buildAppJwt(): Promise<string> {
  const pem = await getPrivateKeyPem();
  const privateKey = await importPKCS8(pem, 'RS256');
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60) // backdate to tolerate clock drift, per GitHub's docs
    .setExpirationTime(now + 9 * 60)
    .setIssuer(GITHUB_APP_ID)
    .sign(privateKey);
}

async function findInstallationId(appJwt: string, repo: string): Promise<number> {
  const res = await fetch(`https://api.github.com/repos/${repo}/installation`, {
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub App is not installed on ${repo} (HTTP ${res.status}): ${await res.text()}`);
  }
  const json = await res.json() as { id: number };
  return json.id;
}

async function createInstallationToken(
  appJwt: string,
  installationId: number,
  repo: string,
): Promise<{ token: string; expiresAt: string }> {
  const [, repoName] = repo.split('/');
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repositories: [repoName],
        permissions: { contents: 'write', pull_requests: 'write' },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to mint installation token for ${repo} (HTTP ${res.status}): ${await res.text()}`);
  }
  const json = await res.json() as { token: string; expires_at: string };
  return { token: json.token, expiresAt: json.expires_at };
}

interface MintGithubTokenArgs {
  repo: string;
}

interface MintGithubTokenResult {
  token: string;
  expiresAt: string;
}

export const handler = async (
  event: { arguments: MintGithubTokenArgs },
): Promise<MintGithubTokenResult> => {
  const { repo } = event.arguments;
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`repo must be in "owner/name" form, got "${repo}"`);
  }

  const appJwt = await buildAppJwt();
  const installationId = await findInstallationId(appJwt, repo);
  const { token, expiresAt } = await createInstallationToken(appJwt, installationId, repo);

  return { token, expiresAt };
};
