export const ClientUserType = {
  ADMIN: 'ADMIN',
  USER: 'USER',
} as const;
export type ClientUserType = (typeof ClientUserType)[keyof typeof ClientUserType];

export interface ClientUser {
  id: string;
  personId: string;
  clientId: string;
  userType: ClientUserType;
  isPrimary: boolean;
  slackUserId: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Common consumer email domains to exclude from domain-based client matching */
export const CONSUMER_EMAIL_DOMAINS = [
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'aol.com',
  'icloud.com',
  'mail.com',
  'protonmail.com',
  'proton.me',
  'live.com',
  'msn.com',
  'ymail.com',
  'zoho.com',
  'fastmail.com',
  'tutanota.com',
  'hey.com',
] as const;
