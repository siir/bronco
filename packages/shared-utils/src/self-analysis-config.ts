/**
 * Shared helper to read the self-analysis configuration from AppSetting.
 * Used by copilot-api (ticket-close gating), ticket-analyzer (post-analysis trigger),
 * and probe-worker (scheduled analysis).
 */

export interface SelfAnalysisConfig {
  postAnalysisTrigger: boolean;
  ticketCloseTrigger: boolean;
  scheduledEnabled: boolean;
  scheduledCron: string;
  repoUrl: string;
  /** 'time' = use scheduleHour/Minute/DaysOfWeek/Timezone; 'cron' = use scheduledCron directly. */
  scheduleType: 'time' | 'cron';
  scheduleHour: number | null;
  scheduleMinute: number | null;
  scheduleDaysOfWeek: string | null;
  scheduleTimezone: string;
}

const DEFAULT_SELF_ANALYSIS_CONFIG: SelfAnalysisConfig = {
  postAnalysisTrigger: false,
  ticketCloseTrigger: true,
  scheduledEnabled: false,
  scheduledCron: '0 9 * * 1',
  repoUrl: 'https://github.com/siir/bronco',
  scheduleType: 'cron',
  scheduleHour: null,
  scheduleMinute: null,
  scheduleDaysOfWeek: null,
  scheduleTimezone: 'America/Chicago',
};

const SETTINGS_KEY = 'self_analysis_config';

/**
 * Read the self_analysis_config AppSetting and merge with defaults.
 * Accepts any object that has an `appSetting.findUnique` method (PrismaClient).
 */
export async function getSelfAnalysisConfig(
  db: { appSetting: { findUnique: (args: { where: { key: string } }) => Promise<{ value: unknown } | null> } },
): Promise<SelfAnalysisConfig> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    if (!row || typeof row.value !== 'object' || row.value === null) {
      return DEFAULT_SELF_ANALYSIS_CONFIG;
    }
    const val = row.value as Record<string, unknown>;
    const rawScheduleType = val['scheduleType'];
    return {
      postAnalysisTrigger: typeof val['postAnalysisTrigger'] === 'boolean' ? val['postAnalysisTrigger'] : DEFAULT_SELF_ANALYSIS_CONFIG.postAnalysisTrigger,
      ticketCloseTrigger: typeof val['ticketCloseTrigger'] === 'boolean' ? val['ticketCloseTrigger'] : DEFAULT_SELF_ANALYSIS_CONFIG.ticketCloseTrigger,
      scheduledEnabled: typeof val['scheduledEnabled'] === 'boolean' ? val['scheduledEnabled'] : DEFAULT_SELF_ANALYSIS_CONFIG.scheduledEnabled,
      scheduledCron: typeof val['scheduledCron'] === 'string' ? val['scheduledCron'] : DEFAULT_SELF_ANALYSIS_CONFIG.scheduledCron,
      repoUrl: typeof val['repoUrl'] === 'string' ? val['repoUrl'] : DEFAULT_SELF_ANALYSIS_CONFIG.repoUrl,
      scheduleType: rawScheduleType === 'time' || rawScheduleType === 'cron' ? rawScheduleType : DEFAULT_SELF_ANALYSIS_CONFIG.scheduleType,
      scheduleHour: typeof val['scheduleHour'] === 'number' ? val['scheduleHour'] : DEFAULT_SELF_ANALYSIS_CONFIG.scheduleHour,
      scheduleMinute: typeof val['scheduleMinute'] === 'number' ? val['scheduleMinute'] : DEFAULT_SELF_ANALYSIS_CONFIG.scheduleMinute,
      scheduleDaysOfWeek: typeof val['scheduleDaysOfWeek'] === 'string' ? val['scheduleDaysOfWeek'] : DEFAULT_SELF_ANALYSIS_CONFIG.scheduleDaysOfWeek,
      scheduleTimezone: typeof val['scheduleTimezone'] === 'string' ? val['scheduleTimezone'] : DEFAULT_SELF_ANALYSIS_CONFIG.scheduleTimezone,
    };
  } catch {
    return DEFAULT_SELF_ANALYSIS_CONFIG;
  }
}
