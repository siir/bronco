import type { ClientUserType } from './client-user.js';

export interface Person {
  id: string;
  clientId: string;
  name: string;
  email: string;
  phone: string | null;
  role: string | null;
  slackUserId: string | null;
  isPrimary: boolean;
  hasPortalAccess: boolean;
  userType: ClientUserType | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
