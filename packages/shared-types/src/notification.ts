export const NotificationChannelType = {
  EMAIL: 'EMAIL',
  PUSHOVER: 'PUSHOVER',
} as const;
export type NotificationChannelType =
  (typeof NotificationChannelType)[keyof typeof NotificationChannelType];

export interface NotificationChannelRecord {
  id: string;
  name: string;
  type: NotificationChannelType;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Type-specific config (secrets redacted in API responses). */
  config: Record<string, unknown>;
}
