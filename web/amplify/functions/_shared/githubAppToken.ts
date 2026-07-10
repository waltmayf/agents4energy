import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SignJWT, importPKCS8 } from 'jose';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const secretsManager = new SecretsManagerClient({ region: REGION });

// Cached across warm invocations — the PEM never changes between requests.
let cachedPrivateKeyPem: string | null = null;

async function getPrivateKeyPem(secretArn: string): Promise<string> {
  if (cachedPrivateKeyPem) return cachedPrivateKeyPem;
  const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const pem = result.SecretString;
  if (!pem) throw new Error('GitHub App private key secret has no SecretString');
  cachedPrivateKeyPem = pem;
  return pem;
}

// A GitHub App JWT is only used to authenticate the installation-token exchange
// below; it's valid for at most 10 minutes per GitHub's docs and is never
// returned to the caller.
async function buildAppJwt(appId: string, secretArn: string): Promise<string> {
  const pem = await getPrivateKeyPem(secretArn);
  const privateKey = await importPKCS8(pem, 'RS256');
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60) // backdate to tolerate clock drift, per GitHub's docs
    .setExpirationTime(now + 9 * 60)
    .setIssuer(appId)
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

// Mints a short-lived (~1h) GitHub App installation token scoped to `repo`
// with contents:write + pull_requests:write. Shared by mint-github-token
// (the browser-initiated /chat-handler flow) and the webhook Step Function
// Lambdas (agent-webhook-post-comment, agent-webhook-invoke-agent) so both
// paths mint tokens the same way instead of each re-implementing the GitHub
// App JWT dance.
export async function mintInstallationToken(
  repo: string,
  appId: string,
  privateKeySecretArn: string,
): Promise<{ token: string; expiresAt: string }> {
  const appJwt = await buildAppJwt(appId, privateKeySecretArn);
  const installationId = await findInstallationId(appJwt, repo);
  return createInstallationToken(appJwt, installationId, repo);
}
