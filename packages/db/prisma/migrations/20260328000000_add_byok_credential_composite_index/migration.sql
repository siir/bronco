-- Add composite index on (client_id, provider, is_active) to support the
-- BYOK credential lookup query: WHERE client_id = ? AND provider = ? AND is_active = true
CREATE INDEX "ClientAiCredential_clientId_provider_isActive_idx" ON "client_ai_credentials"("client_id", "provider", "is_active");
