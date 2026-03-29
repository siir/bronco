export const DbEngine = {
  MSSQL: 'MSSQL',
  AZURE_SQL_MI: 'AZURE_SQL_MI',
  POSTGRESQL: 'POSTGRESQL',
  MYSQL: 'MYSQL',
} as const;
export type DbEngine = (typeof DbEngine)[keyof typeof DbEngine];

export const AuthMethod = {
  SQL_AUTH: 'SQL_AUTH',
  WINDOWS_AUTH: 'WINDOWS_AUTH',
  AZURE_AD: 'AZURE_AD',
} as const;
export type AuthMethod = (typeof AuthMethod)[keyof typeof AuthMethod];

export const Environment = {
  PRODUCTION: 'PRODUCTION',
  STAGING: 'STAGING',
  DEVELOPMENT: 'DEVELOPMENT',
  DR: 'DR',
} as const;
export type Environment = (typeof Environment)[keyof typeof Environment];

export interface System {
  id: string;
  clientId: string;
  name: string;
  dbEngine: DbEngine;
  host: string;
  port: number;
  connectionString: string | null;
  instanceName: string | null;
  defaultDatabase: string | null;
  authMethod: AuthMethod;
  username: string | null;
  encryptedPassword: string | null;
  useTls: boolean;
  trustServerCert: boolean;
  connectionTimeout: number;
  requestTimeout: number;
  maxPoolSize: number;
  isActive: boolean;
  environment: Environment;
  environmentId: string | null;
  notes: string | null;
  lastConnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SystemConnectionConfig {
  id: string;
  clientId: string;
  name: string;
  dbEngine: DbEngine;
  host: string;
  port: number;
  connectionString: string | null;
  instanceName: string | null;
  defaultDatabase: string | null;
  authMethod: AuthMethod;
  username: string | null;
  password: string | null;
  useTls: boolean;
  trustServerCert: boolean;
  connectionTimeout: number;
  requestTimeout: number;
  maxPoolSize: number;
  environment: Environment;
}
