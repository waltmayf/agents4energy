import { defineFunction } from '@aws-amplify/backend';

export const writeActiveRun = defineFunction({
  name: 'write-active-run',
  entry: './handler.ts',
});
