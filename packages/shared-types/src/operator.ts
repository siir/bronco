export const OperatorRole = {
  ADMIN: 'ADMIN',
  STANDARD: 'STANDARD',
} as const;
export type OperatorRole = (typeof OperatorRole)[keyof typeof OperatorRole];

/** Roles allowed to access the control panel (all operators). */
export const CONTROL_PANEL_ROLES: readonly OperatorRole[] = [
  OperatorRole.ADMIN,
  OperatorRole.STANDARD,
] as const;

export interface Operator {
  id: string;
  personId: string;
  clientId: string | null;
  role: OperatorRole;
  themePreference: string;
  notifyEmail: boolean;
  notifySlack: boolean;
  slackUserId: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
