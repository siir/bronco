-- Rename BYOK credential index to match repo snake_case naming convention
ALTER INDEX IF EXISTS "ClientAiCredential_clientId_provider_isActive_idx"
  RENAME TO "client_ai_credentials_client_id_provider_is_active_idx";
