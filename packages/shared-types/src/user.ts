export const UserRole = {
  ADMIN: 'ADMIN',
  OPERATOR: 'OPERATOR',
  CLIENT: 'CLIENT',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** Roles allowed to access the control panel */
export const CONTROL_PANEL_ROLES: readonly UserRole[] = [
  UserRole.ADMIN,
  UserRole.OPERATOR,
] as const;

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  clientId: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
