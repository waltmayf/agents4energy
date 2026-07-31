import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { generateClient } from 'aws-amplify/data';
import { Amplify } from 'aws-amplify';
import type { Schema } from '../../data/resource';
import { env } from '$amplify/env/write-active-run';
import { writeActiveRunWithClient, type WriteActiveRunEvent, type WriteActiveRunResult } from './logic';

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

export const handler = async (event: WriteActiveRunEvent): Promise<WriteActiveRunResult> =>
  writeActiveRunWithClient(client, event);
