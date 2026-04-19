export const AccessType = {
  OPERATOR: 'OPERATOR',
  CLIENT_USER: 'CLIENT_USER',
} as const;
export type AccessType = (typeof AccessType)[keyof typeof AccessType];
