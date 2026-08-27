import { a } from '@aws-amplify/backend';
import { slurmJobSubmitter } from '../../functions/slurm-job-submitter/resource';

export const slurmSchema = a.schema({
  // Custom type for job submission result
  SlurmJobResult: a.customType({
    success: a.boolean().required(),
    jobId: a.string(),
    message: a.string(),
    error: a.string(),
  }),

  // Mutation to submit a job to SLURM via REST API
  submitSlurmJob: a
    .mutation()
    .arguments({
      clusterId: a.string().required(),
      queueName: a.string().required(),
      jobScript: a.string().required(),
      jobName: a.string(),
      nodes: a.integer(),
      tasks: a.integer(),
    })
    .returns(a.ref('SlurmJobResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(slurmJobSubmitter)),
});
