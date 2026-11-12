-- Spec 030 (E1): "dispensar" o assistente de primeiros passos, uma vez por empresa. Migration ADITIVA: uma
-- coluna anulavel, sem default e sem indice (nulo = nao dispensado; empresas existentes nao mudam).

-- AlterTable
ALTER TABLE "companies" ADD COLUMN "onboarding_dismissed_at" TIMESTAMPTZ(6);
