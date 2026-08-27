import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pcs from 'aws-cdk-lib/aws-pcs';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import { Construct } from 'constructs';
import { CfnOutput, Names, Stack, Fn } from 'aws-cdk-lib';


export interface RealTimeParallelClusterProps {
  storageBucketName: string; // Pass separately to avoid cross-stack grantReadWrite
  vpc: ec2.IVpc;
  clusterSecurityGroup: ec2.ISecurityGroup; // Pass from networking stack to avoid circular deps
  clusterSize?: number; // Number of compute nodes to keep warm (default: 0 = scale to zero)
  customComputeAmiId?: string; // Optional custom AMI for compute nodes (e.g. OpenFOAM AMI)
}


/**
 * AWS Parallel Cluster for Real-Time CFD with Data Assimilation
 *
 * Cost-optimised for demo:
 * - FSx Lustre for high-performance shared storage with S3 integration
 * - Slurm ScaledownIdletime: 600 → compute nodes terminate after 10 min idle
 * - MinCount: 0                  → cluster scales to zero, no compute charges when idle
 * - Login node: t3.medium (always-on, ~$0.04/hr = ~$30/month)
 * - Compute nodes: hpc7g.4xlarge → provisioned on demand by Slurm, terminated when idle
 * - ParallelCluster provisioned via AWS PCS (Parallel Computing Service)
 */
export class RealTimeParallelCluster extends Construct {
  public readonly cluster: pcs.CfnCluster;
  public readonly loginNodeGroup: pcs.CfnComputeNodeGroup;
  public readonly computeNodeGroup: pcs.CfnComputeNodeGroup;
  public readonly queue: pcs.CfnQueue;
  public readonly clusterId: string;
  public readonly queueId: string;
  public readonly vpc: ec2.IVpc;
  public readonly clusterSecurityGroup: ec2.SecurityGroup;
  public readonly privateSubnetIds: string[];
  public readonly fsxFileSystem: fsx.CfnFileSystem;
  public readonly hpcBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: RealTimeParallelClusterProps) {
    super(scope, id);

    const stack = Stack.of(this);

    // ========================================================================
    // S3 BUCKET (HPC data)
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
    // VPC & NETWORKING
    // ========================================================================
    this.vpc = props.vpc;

    this.clusterSecurityGroup = new ec2.SecurityGroup(this, 'ClusterSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for PCS cluster',
      allowAllOutbound: true,
    });

    this.clusterSecurityGroup.addIngressRule(
      this.clusterSecurityGroup,
      ec2.Port.allTraffic(),
      'Allow internal cluster communication'
    );

    this.privateSubnetIds = this.vpc.privateSubnets.map(subnet => subnet.subnetId);
    const publicSubnetIds = this.vpc.publicSubnets.map(subnet => subnet.subnetId);
    const clusterSubnetIds = this.privateSubnetIds.length > 0 ? [this.privateSubnetIds[0]] : [publicSubnetIds[0]];

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
    // PCS CLUSTER
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
      vpc: this.vpc,
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
        importPath: `s3://${storageBucket.bucketName}/cfd-simulations`,
        exportPath: `s3://${storageBucket.bucketName}/cfd-simulations`,
        autoImportPolicy: 'NEW_CHANGED',
      },
      tags: [{ key: 'Name', value: 'hpc-lustre-fs' }],
    });

    this.fsxFileSystem.addDependency(fsxIngressFromCluster);
    this.fsxFileSystem.addDependency(fsxIngressSelf);
    this.fsxFileSystem.addDependency(clusterEgressToFsx);
    this.fsxFileSystem.addDependency(this.cluster);

    // ========================================================================
    // HELPER: Generate FSx mount user data snippet
    // ========================================================================
    // FSx DNS: <filesystem-id>.fsx.<region>.amazonaws.com
    // Mount: mount -t lustre <dns>@tcp:/<mount_name> /fsx
    const fsxMountScript = Fn.join('', [
      '# Install Lustre client\n',
      'amazon-linux-extras install -y lustre 2>/dev/null || yum install -y lustre-client 2>/dev/null || true\n',
      '\n',
      '# Mount FSx for Lustre at /fsx\n',
      'mkdir -p /fsx\n',
      'FSX_DNS="', this.fsxFileSystem.ref, '.fsx.', stack.region, '.amazonaws.com"\n',
      'FSX_MOUNT="', Fn.getAtt(this.fsxFileSystem.logicalId, 'LustreMountName').toString(), '"\n',
      'for i in 1 2 3; do\n',
      '  mount -t lustre ${FSX_DNS}@tcp:/${FSX_MOUNT} /fsx && break\n',
      '  echo "FSx mount attempt $i failed, retrying in 10s..."\n',
      '  sleep 10\n',
      'done\n',
      'if mountpoint -q /fsx; then\n',
      '  echo "FSx mounted successfully at /fsx"\n',
      '  mkdir -p /fsx/cfd-simulations/logs\n',
      '  chmod 777 /fsx/cfd-simulations /fsx/cfd-simulations/logs\n',
      'else\n',
      '  echo "ERROR: FSx mount failed after 3 attempts"\n',
      'fi\n',
    ]);

    // ========================================================================
    // AMIs
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
            { key: 'Name', value: 'PCS-Login-Node' },
            { key: 'NodeType', value: 'login' },
          ],
        }],
      },
    });

    // ========================================================================
    // LOGIN NODE GROUP
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
    // COMPUTE NODE GROUP
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
    if (props.customComputeAmiId) {
      new CfnOutput(this, 'CustomComputeAmiId', {
        value: props.customComputeAmiId,
        description: 'Custom AMI ID used for compute nodes (OpenFOAM)',
      });
    }
  }
}
