import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Amplify deploy artifacts: `.amplify/artifacts/cdk.out/**` holds bundled/
    // minified CDK Lambda assets, and `.amplify/generated/**` is generated env
    // typing. Linting them produced ~59k noise errors and made `pnpm lint`
    // unusable (issue #139). They are not first-party source.
    ".amplify/**",
  ]),
]);

export default eslintConfig;
