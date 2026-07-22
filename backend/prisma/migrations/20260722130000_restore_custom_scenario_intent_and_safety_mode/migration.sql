-- A later merged migration (20260722120512_add_pronunciation_accent) dropped these two
-- columns because it was generated against a schema snapshot that predated them. Restoring.
ALTER TABLE "custom_scenarios" ADD COLUMN     "intent" TEXT NOT NULL DEFAULT '';
ALTER TABLE "custom_scenarios" ADD COLUMN     "safetyMode" BOOLEAN NOT NULL DEFAULT false;
