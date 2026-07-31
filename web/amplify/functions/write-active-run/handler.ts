import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { generateClient } from 'aws-amplify/data';
import { Amplify } from 'aws-amplify';
import type { Schema } from '../../data/resource';
import { writeActiveRunWithClient, type WriteActiveRunEvent, type WriteActiveRunResult } from './logic';

// The `$amplify/env/write-active-run` shim is generated only at synth/deploy
// (`.amplify/generated/` is gitignored), so importing it breaks the
// credential-free `tsc` gate on a fresh checkout. Cast `process.env` the same
// way that generated file does — Amplify injects the data-access vars at
// deploy time, so this resolves identically at runtime.
const env = process.env as unknown as Parameters<typeof getAmplifyDataClientConfig>[0];

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

export const handler = async (event: WriteActiveRunEvent): Promise<WriteActiveRunResult> =>
  writeActiveRunWithClient(client, event);
