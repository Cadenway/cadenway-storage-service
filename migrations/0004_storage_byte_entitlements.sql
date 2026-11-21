CREATE TABLE "storage_byte_entitlements" (
	"organization_id" uuid NOT NULL,
	"version" bigint NOT NULL,
	"limit_bytes" bigint NOT NULL,
	CONSTRAINT "storage_byte_entitlements_pkey" PRIMARY KEY("organization_id"),
	CONSTRAINT "storage_byte_entitlements_version_check" CHECK ("storage_byte_entitlements"."version" between 1 and 9007199254740991),
	CONSTRAINT "storage_byte_entitlements_limit_check" CHECK ("storage_byte_entitlements"."limit_bytes" between 2000000000 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "storage_byte_entitlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storage_byte_entitlements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "storage_byte_entitlements_organization_isolation" ON "storage_byte_entitlements" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');
