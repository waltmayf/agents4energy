import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pcs from 'aws-cdk-lib/aws-pcs';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import { Construct } from 'constructs';
import { CfnOutput, Names, Stack, Fn } from 'aws-cdk-lib';

export interface RealTimeParallelClusterProps {
  /** VPC the cluster + FSx filesystem are deployed into. */
  vpc: ec2.IVpc;
  /** Optional custom AMI for compute nodes (e.g. an OpenFOAM AMI baked with the toolchain the CFD tools need). */
  customComputeAmiId?: string;
}

/**
 * AWS PCS (Parallel Computing Service) + Slurm + FSx-Lustre cluster for
 * real-time CFD (issue #503, epic #498 slice 5). Ported from
 * reference/genai-demos/amplify/custom/parallelClusterRealTime.ts.
 *
 * Cost-optimised, but still not free — this is the resource the enableHpc
 * context flag in backend.ts gates:
 * - Login node (t3.medium, always-on, ~$0.03/hr) and FSx-Lustre PERSISTENT_1
 *   (1200 GiB, ~50 MBps/TiB) run 24/7 as soon as this construct is deployed.
 * - Compute nodes (hpc7g.4xlarge) are provisioned on demand by Slurm and
 *   terminated after ScaledownIdletime (600s) — MinCount 0 means no compute
 *   charges while idle.
 */
export class RealTimeParallelCluster extends Construct {
  public readonly cluster: pcs.CfnCluster;
  public readonly loginNodeGroup: pcs.CfnComputeNodeGroup;
  public readonly computeNodeGroup: pcs.CfnComputeNodeGroup;
  public readonly queue: pcs.CfnQueue;
  public readonly clusterId: string;
  public readonly queueId: string;
  public readonly clusterSecurityGroup: ec2.SecurityGroup;
  public readonly fsxFileSystem: fsx.CfnFileSystem;
  public readonly hpcBucket: s3.Bucket;
  /** FSx-Lustre DNS name — mount with `mount -t lustre <fsxDnsName>@tcp:/<mountName> /fsx`. */
  public readonly fsxDnsName: string;
  /** FSx-Lustre mount name (the LustreMountName attribute). */
  public readonly fsxMountName: string;
  /** `Name` tag value applied to the PCS login node instance — use this to look it up via ec2:DescribeInstances. */
  public readonly loginNodeNameTag: string;
  /** S3 prefix (under the bucket this construct owns) that FSx imports/exports via `autoImportPolicy NEW_CHANGED`. */
  public readonly cfdSimulationsPrefix = 'cfd-simulations';

  constructor(scope: Construct, id: string, props: RealTimeParallelClusterProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const vpc = props.vpc;

    // ========================================================================
    // S3 BUCKET (HPC data) — FSx imports/exports s3://<bucket>/cfd-simulations
    // ========================================================================
    const storageBucket = new s3.Bucket(this, 'HpcBucket');
    this.hpcBucket = storageBucket;

    storageBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowFSxServiceLinkedRoleAccess',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ArnPrincipal(`arn:aws:iam::${stack.account}:root`)],
      actions: [
        's3:AbortMultipartUpload',
        's3:DeleteObject',
        's3:PutObject',
        's3:Get*',
        's3:List*',
        's3:PutBucketNotification',
      ],
      resources: [
        storageBucket.bucketArn,
        `${storageBucket.bucketArn}/*`,
      ],
      conditions: {
        StringLike: {
          'aws:userid': 'AIDAI*:AWSServiceRoleForFSxS3Access_fs-*',
        },
      },
    }));

    // ========================================================================
    // NETWORKING
    // ========================================================================
    this.clusterSecurityGroup = new ec2.SecurityGroup(this, 'ClusterSecurityGroup', {
      vpc,
      description: 'Security group for PCS cluster',
      allowAllOutbound: true,
    });

    this.clusterSecurityGroup.addIngressRule(
      this.clusterSecurityGroup,
      ec2.Port.allTraffic(),
      'Allow internal cluster communication',
    );

    const privateSubnetIds = vpc.privateSubnets.map((subnet) => subnet.subnetId);
    const publicSubnetIds = vpc.publicSubnets.map((subnet) => subnet.subnetId);
    const clusterSubnetIds = privateSubnetIds.length > 0 ? [privateSubnetIds[0]] : [publicSubnetIds[0]];

    // ========================================================================
    // IAM
    // ========================================================================
    const clusterRole = new iam.Role(this, 'ClusterInstanceRole', {
      path: '/aws-pcs/',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    clusterRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['pcs:RegisterComputeNodeGroupInstance'],
      resources: ['*'],
    }));

    clusterRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:Get*', 's3:List*', 's3:PutObject', 's3:DeleteObject'],
      resources: [
        storageBucket.bucketArn,
        `${storageBucket.bucketArn}/*`,
      ],
    }));

    const instanceProfile = new iam.CfnInstanceProfile(this, 'ClusterInstanceProfile', {
      roles: [clusterRole.roleName],
    });

    // ========================================================================
    // PCS CLUSTER — Slurm 25.05, scale-to-zero compute, Slurm REST enabled
    // ========================================================================
    this.cluster = new pcs.CfnCluster(this, 'OpenFoamCluster', {
      name: `openfoam-cluster-${Names.uniqueId(this).slice(-8)}`,
      scheduler: {
        type: 'SLURM',
        version: '25.05',
      },
      size: 'SMALL',
      networking: {
        subnetIds: clusterSubnetIds,
        securityGroupIds: [this.clusterSecurityGroup.securityGroupId],
      },
      slurmConfiguration: {
        scaleDownIdleTimeInSeconds: 600,
        slurmRest: {
          mode: 'STANDARD',
        },
      },
    });

    this.clusterId = this.cluster.attrId;
    this.cluster.node.addDependency(clusterRole);
    this.cluster.node.addDependency(instanceProfile);

    // ========================================================================
    // FSx FOR LUSTRE (must be created before launch templates that reference it)
    // ========================================================================
    const fsxSecurityGroup = new ec2.SecurityGroup(this, 'FsxSecurityGroup', {
      vpc,
      description: 'Security group for FSx for Lustre',
      allowAllOutbound: true,
    });

    const fsxIngressFromCluster = new ec2.CfnSecurityGroupIngress(this, 'FsxIngressFromCluster', {
      groupId: fsxSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 988,
      toPort: 988,
      sourceSecurityGroupId: this.clusterSecurityGroup.securityGroupId,
      description: 'Lustre traffic from cluster',
    });

    const fsxIngressSelf = new ec2.CfnSecurityGroupIngress(this, 'FsxIngressSelf', {
      groupId: fsxSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 988,
      toPort: 988,
      sourceSecurityGroupId: fsxSecurityGroup.securityGroupId,
      description: 'Lustre traffic within FSx',
    });

    const clusterEgressToFsx = new ec2.CfnSecurityGroupEgress(this, 'ClusterEgressToFsx', {
      groupId: this.clusterSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 988,
      toPort: 988,
      destinationSecurityGroupId: fsxSecurityGroup.securityGroupId,
      description: 'Lustre traffic to FSx',
    });

    this.fsxFileSystem = new fsx.CfnFileSystem(this, 'LustreFileSystem', {
      fileSystemType: 'LUSTRE',
      subnetIds: [clusterSubnetIds[0]],
      securityGroupIds: [fsxSecurityGroup.securityGroupId],
      storageCapacity: 1200,
      lustreConfiguration: {
        deploymentType: 'PERSISTENT_1',
        perUnitStorageThroughput: 50,
        dataCompressionType: 'LZ4',
        importPath: `s3://${storageBucket.bucketName}/${this.cfdSimulationsPrefix}`,
        exportPath: `s3://${storageBucket.bucketName}/${this.cfdSimulationsPrefix}`,
        autoImportPolicy: 'NEW_CHANGED',
      },
      tags: [{ key: 'Name', value: 'hpc-lustre-fs' }],
    });

    this.fsxFileSystem.addDependency(fsxIngressFromCluster);
    this.fsxFileSystem.addDependency(fsxIngressSelf);
    this.fsxFileSystem.addDependency(clusterEgressToFsx);
    this.fsxFileSystem.addDependency(this.cluster);

    this.fsxDnsName = `${this.fsxFileSystem.ref}.fsx.${stack.region}.amazonaws.com`;
    this.fsxMountName = Fn.getAtt(this.fsxFileSystem.logicalId, 'LustreMountName').toString();

    // ========================================================================
    // HELPER: FSx mount user-data snippet, shared by both launch templates
    // ========================================================================
    // Mount: mount -t lustre <dns>@tcp:/<mount_name> /fsx
    const fsxMountScript = Fn.join('', [
      '# Install Lustre client\n',
      'amazon-linux-extras install -y lustre 2>/dev/null || yum install -y lustre-client 2>/dev/null || true\n',
      '\n',
      '# Mount FSx for Lustre at /fsx\n',
      'mkdir -p /fsx\n',
      'FSX_DNS="', this.fsxDnsName, '"\n',
      'FSX_MOUNT="', this.fsxMountName, '"\n',
      'for i in 1 2 3; do\n',
      '  mount -t lustre ${FSX_DNS}@tcp:/${FSX_MOUNT} /fsx && break\n',
      '  echo "FSx mount attempt $i failed, retrying in 10s..."\n',
      '  sleep 10\n',
      'done\n',
      'if mountpoint -q /fsx; then\n',
      '  echo "FSx mounted successfully at /fsx"\n',
      `  mkdir -p /fsx/${this.cfdSimulationsPrefix}/logs\n`,
      `  chmod 777 /fsx/${this.cfdSimulationsPrefix} /fsx/${this.cfdSimulationsPrefix}/logs\n`,
      'else\n',
      '  echo "ERROR: FSx mount failed after 3 attempts"\n',
      'fi\n',
    ]);

    // ========================================================================
    // AMIs — AWS-published PCS AMIs (arm64 for hpc7g compute, x86 for the
    // t3.medium login node); customComputeAmiId overrides the compute AMI
    // with e.g. a pre-baked OpenFOAM image.
    // ========================================================================
    const arm64PcsAmiId = 'ami-0da469976bf63c08b';
    const x86PcsAmiId = 'ami-09f1c3a1c4da63269';
    const computeAmiId = props.customComputeAmiId || arm64PcsAmiId;

    // ========================================================================
    // COMPUTE NODE LAUNCH TEMPLATE
    // ========================================================================
    const computeUserDataRaw = props.customComputeAmiId
      ? Fn.join('', [
          'Content-Type: multipart/mixed; boundary="==BOUNDARY=="\n',
          'MIME-Version: 1.0\n',
          '\n',
          '--==BOUNDARY==\n',
          'Content-Type: text/x-shellscript; charset="us-ascii"\n',
          '\n',
          '#!/bin/bash\n',
          'set -ex\n',
          'echo "Configuring compute node with custom OpenFOAM AMI..."\n',
          '\n',
          fsxMountScript,
          '\n',
          'echo "Compute node configuration complete"\n',
          '\n',
          '--==BOUNDARY==--\n',
        ])
      : undefined;

    const launchTemplate = new ec2.CfnLaunchTemplate(this, 'ComputeLaunchTemplate', {
      launchTemplateData: {
        instanceType: 'hpc7g.4xlarge',
        imageId: computeAmiId,
        iamInstanceProfile: { arn: instanceProfile.attrArn },
        securityGroupIds: [this.clusterSecurityGroup.securityGroupId],
        ...(computeUserDataRaw ? { userData: Fn.base64(computeUserDataRaw) } : {}),
        tagSpecifications: [{
          resourceType: 'instance',
          tags: [{ key: 'Name', value: 'PCS-Compute-Node' }],
        }],
      },
    });

    // ========================================================================
    // LOGIN NODE LAUNCH TEMPLATE (also mounts FSx)
    // ========================================================================
    this.loginNodeNameTag = 'PCS-Login-Node';

    const loginNodeUserDataRaw = Fn.join('', [
      'Content-Type: multipart/mixed; boundary="==BOUNDARY=="\n',
      'MIME-Version: 1.0\n',
      '\n',
      '--==BOUNDARY==\n',
      'Content-Type: text/x-shellscript; charset="us-ascii"\n',
      '\n',
      '#!/bin/bash\n',
      'set -ex\n',
      'echo "Configuring PCS login node..."\n',
      '\n',
      fsxMountScript,
      '\n',
      '# Ensure Slurm binaries are on PATH for SSM sessions\n',
      'echo "export PATH=/opt/slurm/bin:/usr/local/bin:$PATH" >> /etc/profile.d/slurm.sh\n',
      '\n',
      'echo "Login node configuration complete"\n',
      '\n',
      '--==BOUNDARY==--\n',
    ]);

    const loginLaunchTemplate = new ec2.CfnLaunchTemplate(this, 'LoginLaunchTemplate', {
      launchTemplateData: {
        instanceType: 't3.medium',
        imageId: x86PcsAmiId,
        iamInstanceProfile: { arn: instanceProfile.attrArn },
        securityGroupIds: [this.clusterSecurityGroup.securityGroupId],
        userData: Fn.base64(loginNodeUserDataRaw),
        tagSpecifications: [{
          resourceType: 'instance',
          tags: [
            { key: 'Name', value: this.loginNodeNameTag },
            { key: 'NodeType', value: 'login' },
          ],
        }],
      },
    });

    // ========================================================================
    // LOGIN NODE GROUP — always-on, exactly 1 instance
    // ========================================================================
    this.loginNodeGroup = new pcs.CfnComputeNodeGroup(this, 'LoginNodeGroup', {
      clusterId: this.cluster.attrId,
      name: `login-nodes-${Names.uniqueId(this).slice(-8)}`,
      instanceConfigs: [{ instanceType: 't3.medium' }],
      subnetIds: clusterSubnetIds,
      customLaunchTemplate: {
        templateId: loginLaunchTemplate.ref,
        version: loginLaunchTemplate.attrLatestVersionNumber,
      },
      iamInstanceProfileArn: instanceProfile.attrArn,
      scalingConfiguration: {
        minInstanceCount: 1,
        maxInstanceCount: 1,
      },
    });

    this.loginNodeGroup.addDependency(this.cluster);
    this.loginNodeGroup.node.addDependency(clusterRole);
    this.loginNodeGroup.node.addDependency(instanceProfile);

    // ========================================================================
    // COMPUTE NODE GROUP — scale-to-zero, Slurm provisions on demand
    // ========================================================================
    this.computeNodeGroup = new pcs.CfnComputeNodeGroup(this, 'HpcNodeGroup', {
      clusterId: this.cluster.attrId,
      name: `hpc7g-nodes-${Names.uniqueId(this).slice(-8)}`,
      instanceConfigs: [{ instanceType: 'hpc7g.4xlarge' }],
      subnetIds: clusterSubnetIds,
      customLaunchTemplate: {
        templateId: launchTemplate.ref,
        version: launchTemplate.attrLatestVersionNumber,
      },
      iamInstanceProfileArn: instanceProfile.attrArn,
      scalingConfiguration: {
        minInstanceCount: 0,
        maxInstanceCount: 10,
      },
    });

    this.computeNodeGroup.addDependency(this.cluster);
    this.computeNodeGroup.node.addDependency(clusterRole);
    this.computeNodeGroup.node.addDependency(instanceProfile);

    // ========================================================================
    // QUEUE
    // ========================================================================
    this.queue = new pcs.CfnQueue(this, 'PcsQueue', {
      clusterId: this.cluster.attrId,
      name: `main-queue-${Names.uniqueId(this).slice(-8)}`,
      computeNodeGroupConfigurations: [
        { computeNodeGroupId: this.computeNodeGroup.attrId },
      ],
    });

    this.queueId = this.queue.attrId;

    // ========================================================================
    // OUTPUTS
    // ========================================================================
    new CfnOutput(this, 'ClusterId', {
      value: this.clusterId,
      description: 'PCS cluster ID',
    });

    new CfnOutput(this, 'FsxDnsName', {
      value: this.fsxDnsName,
      description: 'FSx for Lustre DNS name',
    });

    new CfnOutput(this, 'LoginNodeNameTag', {
      value: this.loginNodeNameTag,
      description: 'EC2 Name tag identifying the PCS login node instance',
    });

    if (props.customComputeAmiId) {
      new CfnOutput(this, 'CustomComputeAmiId', {
        value: props.customComputeAmiId,
        description: 'Custom AMI ID used for compute nodes (OpenFOAM)',
      });
    }
  }
}
