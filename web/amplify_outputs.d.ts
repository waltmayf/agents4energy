// Ambient declaration for the deploy-generated, gitignored `amplify_outputs.json`
// (see web/.gitignore). Amplify writes this file at deploy time with the real
// Cognito/AppSync IDs; it is absent in a fresh checkout and in CI. Without a
// declaration, `import outputs from '../amplify_outputs.json'` fails to
// type-check ("Cannot find module") whenever the file isn't present — which
// previously pushed the webhook harness to force-commit a placeholder JSON into
// its PRs (issue #146). This lets `tsc` resolve the import with no generated
// file, so nothing needs to be committed and the CI checks gate needs no stub.
//
// When the real JSON IS present, TypeScript uses it (a concrete module resolves
// ahead of this ambient wildcard), so this only supplies the type in its absence.
declare module '*/amplify_outputs.json' {
  const outputs: Record<string, unknown>;
  export default outputs;
}
