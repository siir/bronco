export const ClientUserType = {
  ADMIN: 'ADMIN',
  OPERATOR: 'OPERATOR',
  USER: 'USER',
} as const;
export type ClientUserType = (typeof ClientUserType)[keyof typeof ClientUserType];

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
