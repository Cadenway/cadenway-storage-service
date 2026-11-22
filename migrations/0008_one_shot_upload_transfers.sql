CREATE TABLE "upload_transfer_uses" (
	"staging_digest" text PRIMARY KEY NOT NULL,
	"retain_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upload_transfer_uses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "upload_transfer_uses_expiry_index" ON "upload_transfer_uses" USING btree ("retain_until","staging_digest");--> statement-breakpoint
CREATE POLICY "upload_transfer_uses_system_only" ON "upload_transfer_uses" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.system_access', true) = 'on') WITH CHECK (current_setting('app.system_access', true) = 'on');
--> statement-breakpoint
ALTER TABLE "upload_transfer_uses" FORCE ROW LEVEL SECURITY;
