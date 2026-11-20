CREATE TABLE "attachment_candidates" (
	"organization_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cleanup_after" timestamp (3) with time zone NOT NULL,
	"cleanup_generation" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "attachment_candidates_pkey" PRIMARY KEY("organization_id","object_key"),
	CONSTRAINT "attachment_candidates_status_check" CHECK ("attachment_candidates"."status" in ('staging', 'active', 'elected', 'fenced', 'cleaned')),
	CONSTRAINT "attachment_candidates_cleanup_generation_check" CHECK ("attachment_candidates"."cleanup_generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "attachment_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attachment_reconciliation_cursors" (
	"scope" text PRIMARY KEY NOT NULL,
	"continuation" text,
	"lease_id" uuid,
	"leased_until" timestamp (3) with time zone,
	CONSTRAINT "attachment_reconciliation_scope_check" CHECK ("attachment_reconciliation_cursors"."scope" = 'objects'),
	CONSTRAINT "attachment_reconciliation_lease_check" CHECK (("attachment_reconciliation_cursors"."lease_id" is null) = ("attachment_reconciliation_cursors"."leased_until" is null))
);
--> statement-breakpoint
ALTER TABLE "attachment_reconciliation_cursors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attachment_task_tombstones" (
	"organization_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"purged_at" timestamp (3) with time zone,
	"purge_actor_type" text,
	"purge_actor_id" text,
	"cleanup_pending" boolean DEFAULT false NOT NULL,
	CONSTRAINT "attachment_task_tombstones_pkey" PRIMARY KEY("organization_id","task_key"),
	CONSTRAINT "attachment_task_tombstones_actor_check" CHECK (("attachment_task_tombstones"."purged_at" is null and "attachment_task_tombstones"."purge_actor_type" is null and "attachment_task_tombstones"."purge_actor_id" is null) or ("attachment_task_tombstones"."purged_at" is not null and "attachment_task_tombstones"."purge_actor_type" is not null and "attachment_task_tombstones"."purge_actor_type" in ('user', 'automation', 'git', 'system') and "attachment_task_tombstones"."purge_actor_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "attachment_task_tombstones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attachment_upload_claims" (
	"organization_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"key_digest" text NOT NULL,
	"fingerprint" text NOT NULL,
	"claim_id" uuid DEFAULT uuidv7() NOT NULL,
	"key_id" text,
	"nonce" "bytea",
	"ciphertext" "bytea",
	"auth_tag" "bytea",
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "attachment_upload_claims_pkey" PRIMARY KEY("organization_id","actor_id","task_key","key_digest"),
	CONSTRAINT "attachment_upload_claims_nonce_length" CHECK (octet_length("attachment_upload_claims"."nonce") = 12),
	CONSTRAINT "attachment_upload_claims_auth_tag_length" CHECK (octet_length("attachment_upload_claims"."auth_tag") = 16),
	CONSTRAINT "attachment_upload_claims_receipt_shape" CHECK (num_nonnulls("attachment_upload_claims"."key_id", "attachment_upload_claims"."nonce", "attachment_upload_claims"."ciphertext", "attachment_upload_claims"."auth_tag") in (0, 4))
);
--> statement-breakpoint
ALTER TABLE "attachment_upload_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attachments" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"task_key" text NOT NULL,
	"author_user_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"staging_object_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" text NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"version" integer NOT NULL,
	"reserved_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"uploaded_at" timestamp (3) with time zone,
	"deleted_at" timestamp (3) with time zone,
	"elected_object_key" text,
	CONSTRAINT "attachments_pkey" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "attachments_status_check" CHECK ("attachments"."status" in ('pending', 'ready', 'deleted')),
	CONSTRAINT "attachments_scan_status_check" CHECK ("attachments"."scan_status" in ('pending', 'verified')),
	CONSTRAINT "attachments_size_check" CHECK ("attachments"."size_bytes" between 1 and 26214400)
);
--> statement-breakpoint
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachment_candidates" ADD CONSTRAINT "attachment_candidates_attachment_fkey" FOREIGN KEY ("organization_id","attachment_id") REFERENCES "public"."attachments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_candidates_cleanup_index" ON "attachment_candidates" USING btree ("organization_id","cleanup_after","object_key") WHERE "attachment_candidates"."status" in ('staging', 'active', 'fenced');--> statement-breakpoint
CREATE INDEX "attachment_task_tombstones_cleanup_index" ON "attachment_task_tombstones" USING btree ("organization_id","cleanup_pending","task_key");--> statement-breakpoint
CREATE INDEX "attachment_upload_claims_expiry_index" ON "attachment_upload_claims" USING btree ("expires_at","organization_id","actor_id","task_key","key_digest");--> statement-breakpoint
CREATE INDEX "attachments_task_page_index" ON "attachments" USING btree ("organization_id","task_key","status","uploaded_at","id");--> statement-breakpoint
CREATE INDEX "attachments_largest_page_index" ON "attachments" USING btree ("organization_id","status","size_bytes","id");--> statement-breakpoint
CREATE INDEX "attachments_task_purge_index" ON "attachments" USING btree ("organization_id","task_key","id") WHERE "attachments"."status" in ('pending', 'ready');--> statement-breakpoint
CREATE POLICY "attachment_candidates_organization_isolation" ON "attachment_candidates" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "attachment_reconciliation_system_access" ON "attachment_reconciliation_cursors" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.system_access', true) = 'on') WITH CHECK (current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "attachment_task_tombstones_organization_isolation" ON "attachment_task_tombstones" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "attachment_upload_claims_organization_isolation" ON "attachment_upload_claims" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "attachments_organization_isolation" ON "attachments" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
ALTER TABLE "attachment_candidates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachment_reconciliation_cursors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachment_task_tombstones" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachment_upload_claims" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachments" FORCE ROW LEVEL SECURITY;
