# AWS PCS Login Node Bootstrap Issue

> **Resolved (historical).** This documents a past bootstrap failure. The fix that shipped was **Option 2** (a pinned AWS PCS-managed AMI): the login node now uses a custom launch template with the x86 PCS AMI `ami-09f1c3a1c4da63269`, and the login node group runs **always-on (min=1)** as the SSM `sbatch` entry point — *not* scaled to 0. See [README.md](README.md) for current state.

## Problem

Login node instance starts but SLURM is not installed. The bootstrap script fails:

```
/var/lib/cloud/instance/scripts/runcmd: line 2: /opt/aws/pcs/bin/pcs_bootstrap_finalize.sh: No such file or directory
```

## Root Cause

We're using a custom launch template with a standard Amazon Linux 2 AMI, but AWS PCS requires:
1. AWS PCS agent pre-installed on the AMI
2. Proper bootstrap scripts
3. Integration with the PCS control plane

## Current Configuration

```typescript
// amplify/custom/parallelClusterRealTime.ts
const x86Ami = ec2.MachineImage.latestAmazonLinux2({
  cpuType: ec2.AmazonLinuxCpuType.X86_64,
});

const loginLaunchTemplate = new ec2.CfnLaunchTemplate(this, 'LoginLaunchTemplate', {
  launchTemplateData: {
    instanceType: 't3.medium',
    imageId: x86Ami.getImage(this).imageId,  // ← Standard AL2, missing PCS agent
    // ...
  },
});
```

## Solution Options

### Option 1: Remove Custom Launch Template (Recommended)

Let AWS PCS manage the AMI selection and bootstrap process:

```typescript
this.loginNodeGroup = new pcs.CfnComputeNodeGroup(this, 'LoginNodeGroup', {
  clusterId: this.cluster.attrId,
  name: 'login-nodes',
  instanceConfigs: [{ instanceType: 't3.medium' }],
  subnetIds: clusterSubnetIds,
  // Remove customLaunchTemplate - let AWS PCS handle it
  iamInstanceProfileArn: instanceProfile.attrArn,
  scalingConfiguration: {
    minInstanceCount: 1,
    maxInstanceCount: 1
  },
});
```

### Option 2: Use AWS PCS-Managed AMI

If custom launch template is needed, use the AWS PCS-managed AMI:

```typescript
// Get the AWS PCS-managed AMI for the region
const pcsAmi = ec2.MachineImage.lookup({
  name: 'aws-pcs-*',  // AWS PCS provides managed AMIs
  owners: ['amazon'],
});
```

### Option 3: Use SLURM REST API Instead

Since the SLURM REST API is already enabled and working, use that approach instead of login nodes:
- Deploy Lambda function in VPC
- Call SLURM REST API from Lambda
- No login node needed (cost savings)

## Resolution (what shipped)

**Option 2 was adopted.** The launch templates were kept but pointed at pinned AWS PCS-managed AMIs (login: x86 `ami-09f1c3a1c4da63269`; compute: arm64 `ami-0da469976bf63c08b` or a custom OpenFOAM AMI). The login node group runs **always-on (min=1)** because the production submission path uses SSM `sbatch` on it. The SLURM REST API (Option 3) remains available as an alternate VPC-Lambda path but is not the primary route.

## References

- [AWS PCS Compute Node Groups](https://docs.aws.amazon.com/pcs/latest/userguide/compute-node-groups.html)
- [AWS PCS SLURM REST API](https://docs.aws.amazon.com/pcs/latest/userguide/slurm-rest-api.html)

---

**Date:** March 3, 2026 (resolved; doc annotated August 2026)  
**Status:** Resolved — pinned PCS AMI + always-on login node (min=1)
