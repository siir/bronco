import type { OperatorRole } from './operator.js';
import type { ClientUserType } from './client-user.js';

/**
 * Canonical API response shapes consumed by the control panel, ticket portal,
 * and MCP platform server. Wave 2 (copilot-api CRUD, MCP tools, frontend)
 * uses these types to stay in sync with the auth routes.
 */

/** GET /api/auth/me response — operator viewing their own context. */
export interface AuthMeResponse {
  personId: string;
  operatorId: string;
  email: string;
  name: string;
  role: OperatorRole;
  clientId: string | null;
  themePreference: string;
}

/** POST /api/auth/login response. */
export interface AuthLoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthMeResponse;
}

/** GET /api/portal/auth/me response. */
export interface PortalMeResponse {
  personId: string;
  clientUserId: string;
  email: string;
  name: string;
  userType: ClientUserType;
  clientId: string;
  isPrimary: boolean;
}

/** POST /api/portal/auth/login response. */
export interface PortalLoginResponse {
  accessToken: string;
  refreshToken: string;
  user: PortalMeResponse;
}

/** JWT payload for operator access tokens. */
export interface OperatorJwtPayload {
  sub: string;
  operatorId: string;
  email: string;
  role: OperatorRole;
  clientId: string | null;
  type: 'access';
}

/** JWT payload for operator refresh tokens. */
export interface OperatorRefreshPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

/** JWT payload for portal access tokens. */
export interface PortalJwtPayload {
  sub: string;
  clientUserId: string;
  email: string;
  clientId: string;
  userType: ClientUserType;
  type: 'portal_access';
}

/** JWT payload for portal refresh tokens. */
export interface PortalRefreshPayload {
  sub: string;
  jti: string;
  type: 'portal_refresh';
}
