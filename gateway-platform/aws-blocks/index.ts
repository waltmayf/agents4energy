import { ApiNamespace, Scope } from '@aws-blocks/blocks';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Scope below to see the docstring with complete Building Block index

const scope = new Scope('my-app');

// Every method below is a public RPC endpoint — no auth by default.
// To gate one, add an auth block (e.g. @aws-blocks/bb-auth-cognito) and call
// it first — see its README:
//   const user = await auth.requireAuth(context);
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async greet(name: string) {
    return { message: `Hello, ${name}!`, timestamp: Date.now() };
  }
}));
