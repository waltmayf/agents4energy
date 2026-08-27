/**
 * HPC CDK Stack
 *
 * Independent CDK stack containing the AWS PCS (Parallel Computing Service) cluster,
 * FSx for Lustre filesystem, compute/login node groups, and security groups.
 *
 * Imports VPC via Fn.importValue from a pre-existing VPC stack (same pattern as
 * amplify/backend.ts). Optionally accepts a custom compute AMI ID for OpenFOAM.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { RealTimeParallelCluster } from '../../amplify/custom/parallelClusterRealTime';

// ============================================================================
// Stack Props
// ============================================================================

export interface HpcStackProps extends cdk.StackProps {
  /** Sandbox identifier for unique resource naming */
  sandboxId: string;
  /** Optional custom AMI ID for compute nodes (e.g. OpenFOAM AMI) */
  customComputeAmiId?: string;
}

// ============================================================================
// Stack
// ============================================================================

export class HpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HpcStackProps) {
    super(scope, id, props);

    // ========================================================================
    // IMPORT VPC
    // ========================================================================
    // Same pattern as amplify/backend.ts — pre-created VPC with 2 AZs
    const azCount = 2;
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: cdk.Fn.importValue('DemoVpcId'),
      availabilityZones: cdk.Fn.importListValue('DemoVpcAvailabilityZones', azCount),
      publicSubnetIds: cdk.Fn.importListValue('DemoVpcPublicSubnetIds', azCount),
      privateSubnetIds: cdk.Fn.importListValue('DemoVpcPrivateSubnetIds', azCount),
    });

    // ========================================================================
    // IMPORT SECURITY GROUP
    // ========================================================================
    const clusterSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ImportedSecurityGroup',
      cdk.Fn.importValue('DemoVpcDefaultSecurityGroupId'),
    );

    // ========================================================================
    // PARALLEL CLUSTER CONSTRUCT
    // ========================================================================
    const parallelCluster = new RealTimeParallelCluster(this, 'ParallelCluster', {
      storageBucketName: 'PLACEHOLDER', // Construct creates its own HPC bucket
      vpc,
      clusterSecurityGroup,
      customComputeAmiId: props.customComputeAmiId,
    });

    // ========================================================================
    // OUTPUTS
    // ========================================================================
    new cdk.CfnOutput(this, 'ClusterName', {
      value: parallelCluster.cluster.name ?? parallelCluster.cluster.attrId,
      description: 'PCS cluster name',
    });

    new cdk.CfnOutput(this, 'ClusterId', {
      value: parallelCluster.cluster.attrId,
      description: 'PCS cluster ID',
    });

    new cdk.CfnOutput(this, 'FsxFilesystemId', {
      value: parallelCluster.fsxFileSystem.ref,
      description: 'FSx for Lustre filesystem ID',
    });

    new cdk.CfnOutput(this, 'ClusterSecurityGroupId', {
      value: parallelCluster.clusterSecurityGroup.securityGroupId,
      description: 'Cluster security group ID',
    });

    new cdk.CfnOutput(this, 'HpcBucketName', {
      value: parallelCluster.hpcBucket.bucketName,
      description: 'HPC S3 bucket name for FSx integration',
    });

    // Apply project tag
    cdk.Tags.of(this).add('Project', 'a4e');
  }
}
