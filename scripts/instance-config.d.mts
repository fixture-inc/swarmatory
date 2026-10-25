export interface InstanceConfig {
  accountId: string;
  workerName: string;
  databaseId: string;
  databaseName: string;
  publicOrigin: string;
  legacyHosts: string[];
  accessTeamDomain: string;
  accessAud: string;
}
export function loadInstance(options?: {
  required?: boolean;
  root?: string;
}): InstanceConfig;
export function validateInstance(
  config: unknown,
): asserts config is InstanceConfig;
