import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

// Shared credential provider — automatically refreshes expired tokens
const credentialProvider = fromNodeProviderChain();

// Function to safely load outputs
export const loadOutputs = () => {
  try {
    return require('../amplify_outputs.json');
  } catch (error) {
    console.warn('amplify_outputs.json not found - this is expected during initial build');
    return null;
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Amplify's generateClient return type is too deeply recursive for TS declaration emit
export const getConfiguredAmplifyClient = (): any => {
  // Validate required environment variables (non-credential vars only)
  const requiredEnvVars = {
    AMPLIFY_DATA_GRAPHQL_ENDPOINT: process.env.AMPLIFY_DATA_GRAPHQL_ENDPOINT,
    AWS_REGION: process.env.AWS_REGION,
  };

  const missingVars = Object.entries(requiredEnvVars)
    .filter(([_, value]) => !value)
    .map(([key]) => key);

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(', ')}. Ensure credentials are initialized at startup.`
    );
  }

  Amplify.configure(
    {
      API: {
        GraphQL: {
          endpoint: process.env.AMPLIFY_DATA_GRAPHQL_ENDPOINT!,
          region: process.env.AWS_REGION!,
          defaultAuthMode: 'identityPool'
        }
      }
    },
    {
      Auth: {
        credentialsProvider: {
          getCredentialsAndIdentityId: async () => {
            // Fetch fresh credentials on each call — the provider
            // caches internally and only hits the metadata service
            // when the current token is close to expiry.
            const creds = await credentialProvider();
            return {
              credentials: {
                accessKeyId: creds.accessKeyId,
                secretAccessKey: creds.secretAccessKey,
                sessionToken: creds.sessionToken ?? '',
              },
            };
          },
          clearCredentialsAndIdentityId: () => {
            /* noop */
          },
        },
      },
    }
  );

  const amplifyClient = generateClient();

  return amplifyClient;
}
