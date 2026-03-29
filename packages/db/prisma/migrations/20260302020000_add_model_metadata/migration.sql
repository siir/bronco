-- Add model metadata columns to ai_model_costs
ALTER TABLE "ai_model_costs" ADD COLUMN "description" TEXT;
ALTER TABLE "ai_model_costs" ADD COLUMN "context_length" INTEGER;
ALTER TABLE "ai_model_costs" ADD COLUMN "max_completion_tokens" INTEGER;
ALTER TABLE "ai_model_costs" ADD COLUMN "modality" TEXT;
