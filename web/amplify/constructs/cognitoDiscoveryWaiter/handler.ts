// Handler for Cognito Discovery Waiter custom resource
import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';
import https from 'https';

// Simple helper to GET JSON
function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Poll until discovery document contains 'issuer' and 'jwks_uri'
async function waitForDiscovery(url: string, timeoutMs = 2 * 60 * 1000, intervalMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const doc = await getJson(url);
      if (doc && typeof doc.issuer === 'string' && typeof doc.jwks_uri === 'string') {
        return; // success
      }
    } catch (_) {
      // ignore errors and retry
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Cognito discovery document not ready at ${url}`);
}

export async function handler(event: CdkCustomResourceEvent): Promise<CdkCustomResourceResponse> {
  const discoveryUrl = event.ResourceProperties.DiscoveryUrl as string;
  const physicalId = discoveryUrl; // stable identifier

  if (event.RequestType === 'Create' || event.RequestType === 'Update') {
    await waitForDiscovery(discoveryUrl);
    return { PhysicalResourceId: physicalId };
  }
  // Delete: no action needed
  return { PhysicalResourceId: physicalId };
}
