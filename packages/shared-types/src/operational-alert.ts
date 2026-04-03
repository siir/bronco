export const OperationalAlertType = {
  FAILED_JOBS: 'FAILED_JOBS',
  PROBE_MISSES: 'PROBE_MISSES',
  AI_PROVIDER_DOWN: 'AI_PROVIDER_DOWN',
  DEVOPS_SYNC_STALE: 'DEVOPS_SYNC_STALE',
  SUMMARIZATION_STALE: 'SUMMARIZATION_STALE',
} as const;
export type OperationalAlertType =
  (typeof OperationalAlertType)[keyof typeof OperationalAlertType];

export interface OperationalAlertConfig {
  enabled: boolean;
  recipientOperatorId: string;
  throttleMinutes: number;
  alerts: {
    failedJobs: boolean;
    probeMisses: boolean;
    aiProviderDown: boolean;
    devopsSyncStale: boolean;
    summarizationStale: boolean;
  };
}

export const DEFAULT_OPERATIONAL_ALERT_CONFIG: OperationalAlertConfig = {
  enabled: false,
  recipientOperatorId: '',
  throttleMinutes: 60,
  alerts: {
    failedJobs: true,
    probeMisses: true,
    aiProviderDown: true,
    devopsSyncStale: true,
    summarizationStale: true,
  },
};
