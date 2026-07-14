# Setting up Deploy Role for GitHub Actions

This document describes how to configure the required AWS IAM role and GitHub repository secret so that the `deploy.yml` workflow can assume credentials via OIDC.

## Prerequisites

- **AWS credentials** with permission to create IAM OIDC provider, IAM role, and IAM policy. Typically an IAM user or role with `iam:*` and `sts:AssumeRole` permissions.
- **GitHub admin access** to the `waltmayf/agents4energy` repository (required to create repository secrets).
- **Node.js** (>=14) installed locally to run the setup script.

## Steps

1. **Clone the repository** (if you haven't already):
   ```bash
   git clone https://github.com/waltmayf/agents4energy.git
   cd agents4energy
   ```

2. **Install dependencies** (the script uses the AWS SDK and `@actions/github`):
   ```bash
   npm install
   ```

3. **Run the setup script**:
   ```bash
   npx ts-node scripts/setup-deploy-role.ts \
       --aws-account-id <YOUR_AWS_ACCOUNT_ID> \
       --github-repo waltmayf/agents4energy \
       --github-token <YOUR_GITHUB_PERSONAL_ACCESS_TOKEN>
   ```
   - Replace `<YOUR_AWS_ACCOUNT_ID>` with the numeric AWS account ID where the resources will be created.
   - Replace `<YOUR_GITHUB_PERSONAL_ACCESS_TOKEN>` with a PAT that has `repo` scope (required to create repository secrets). The token can be generated from **GitHub Settings → Developer settings → Personal access tokens**.

   The script performs the following actions:
   - Creates an IAM OIDC provider for `https://token.actions.githubusercontent.com` if it does not already exist.
   - Creates an IAM role (named `github-deploy-role-<repo>` by default) that trusts the OIDC provider and allows the `sts:AssumeRoleWithWebIdentity` action.
   - Attaches a minimal policy to the role granting the permissions required for the deployment pipeline (e.g., CloudFormation, S3, IAM, Lambda, etc.).
   - Stores the role ARN as a repository secret named `AWS_ROLE_ARN`.
   - Sets the repository variable `AWS_REGION` (if not already set) to the region you intend to deploy to (default: `us-east-1`).

4. **Verify the secret**:
   In the GitHub UI navigate to **Settings → Secrets and variables → Repository secrets** and confirm that `AWS_ROLE_ARN` now exists.

5. **Run the Deploy workflow**:
   Trigger the workflow manually or push a commit to the `main` branch. The `Configure AWS credentials` step should now succeed.

## Troubleshooting

- If the script reports that the OIDC provider already exists, it will reuse the existing one.
- Ensure the IAM role name does not clash with an existing role. If needed, modify the script's `roleName` variable.
- The GitHub token used must have the `admin:repo_hook` and `repo` scopes to create secrets.
- If you encounter permission errors, double‑check that the AWS credentials you used have sufficient IAM rights.

## Automation (Optional)

You can add a one‑time GitHub Action that runs this script on a `workflow_dispatch` event, but it still requires a PAT with repo scope stored as a secret (e.g., `GH_ADMIN_TOKEN`). See the example workflow in `/.github/workflows/setup-deploy-role.yml` for reference.

---

*This file was added to help repository maintainers quickly set up the AWS deploy role required by the CI/CD pipeline.*