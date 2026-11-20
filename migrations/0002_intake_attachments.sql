CREATE TABLE "intake_attachment_candidates" (
	"organization_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"status" text NOT NULL,
	"cleanup_after" timestamp (3) with time zone NOT NULL,
	"cleanup_generation" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "intake_attachment_candidates_pkey" PRIMARY KEY("organization_id","object_key"),
	CONSTRAINT "intake_attachment_candidates_status_check" CHECK ("intake_attachment_candidates"."status" in ('staging', 'active', 'elected', 'fenced', 'cleaned')),
	CONSTRAINT "intake_attachment_candidates_generation_check" CHECK ("intake_attachment_candidates"."cleanup_generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "intake_attachment_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_attachment_candidates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "intake_attachment_upload_claims" (
	"organization_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"claim_id" uuid DEFAULT uuidv7() NOT NULL,
	"key_id" text,
	"nonce" "bytea",
	"ciphertext" "bytea",
	"auth_tag" "bytea",
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "intake_attachment_upload_claims_pkey" PRIMARY KEY("organization_id","publication_id","attachment_id"),
	CONSTRAINT "intake_attachment_upload_claims_nonce_check" CHECK (octet_length("intake_attachment_upload_claims"."nonce") = 12),
	CONSTRAINT "intake_attachment_upload_claims_tag_check" CHECK (octet_length("intake_attachment_upload_claims"."auth_tag") = 16),
	CONSTRAINT "intake_attachment_upload_claims_receipt_check" CHECK (num_nonnulls("intake_attachment_upload_claims"."key_id", "intake_attachment_upload_claims"."nonce", "intake_attachment_upload_claims"."ciphertext", "intake_attachment_upload_claims"."auth_tag") in (0, 4))
);
--> statement-breakpoint
ALTER TABLE "intake_attachment_upload_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_attachment_upload_claims" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "intake_attachments" (
	"organization_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"status" text NOT NULL,
	"staging_object_key" text,
	"file_name" text,
	"content_type" text,
	"size_bytes" integer,
	"reserved_at" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone,
	"upload_expires_at" timestamp (3) with time zone,
	"candidate_key" text,
	"verified_at" timestamp (3) with time zone,
	"task_key" text,
	"decided_at" timestamp (3) with time zone,
	CONSTRAINT "intake_attachments_pkey" PRIMARY KEY("organization_id","publication_id","id"),
	CONSTRAINT "intake_attachments_status_check" CHECK ("intake_attachments"."status" in ('pending', 'verified', 'claimed', 'released')),
	CONSTRAINT "intake_attachments_reservation_check" CHECK (num_nonnulls("intake_attachments"."staging_object_key", "intake_attachments"."file_name", "intake_attachments"."content_type", "intake_attachments"."size_bytes", "intake_attachments"."reserved_at", "intake_attachments"."expires_at", "intake_attachments"."upload_expires_at") in (0, 7)),
	CONSTRAINT "intake_attachments_size_check" CHECK ("intake_attachments"."size_bytes" is null or "intake_attachments"."size_bytes" between 1 and 26214400),
	CONSTRAINT "intake_attachments_lifecycle_check" CHECK ((
        ("intake_attachments"."status" = 'pending' and "intake_attachments"."staging_object_key" is not null and "intake_attachments"."candidate_key" is null and "intake_attachments"."verified_at" is null and "intake_attachments"."task_key" is null and "intake_attachments"."decided_at" is null)
        or ("intake_attachments"."status" = 'verified' and "intake_attachments"."staging_object_key" is not null and "intake_attachments"."candidate_key" is not null and "intake_attachments"."verified_at" is not null and "intake_attachments"."task_key" is null and "intake_attachments"."decided_at" is null)
        or ("intake_attachments"."status" = 'claimed' and "intake_attachments"."task_key" is not null and "intake_attachments"."decided_at" is not null)
        or ("intake_attachments"."status" = 'released' and "intake_attachments"."task_key" is null and "intake_attachments"."decided_at" is not null)
      ))
);
--> statement-breakpoint
ALTER TABLE "intake_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachment_reconciliation_cursors" DROP CONSTRAINT "attachment_reconciliation_scope_check";--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "author_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "intake_attachment_candidates" ADD CONSTRAINT "intake_attachment_candidates_reservation_fkey" FOREIGN KEY ("organization_id","publication_id","attachment_id") REFERENCES "public"."intake_attachments"("organization_id","publication_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_attachment_candidates_cleanup_index" ON "intake_attachment_candidates" USING btree ("organization_id","cleanup_after","object_key") WHERE "intake_attachment_candidates"."status" in ('staging', 'active', 'fenced');--> statement-breakpoint
CREATE INDEX "intake_attachment_candidates_reservation_index" ON "intake_attachment_candidates" USING btree ("organization_id","publication_id","attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_attachment_candidates_opaque_staging_key_unique" ON "intake_attachment_candidates" USING btree ("object_key") WHERE "intake_attachment_candidates"."object_key" like 'intake/%';--> statement-breakpoint
CREATE INDEX "intake_attachment_upload_claims_expiry_index" ON "intake_attachment_upload_claims" USING btree ("expires_at","organization_id","publication_id","attachment_id");--> statement-breakpoint
ALTER TABLE "attachment_reconciliation_cursors" ADD CONSTRAINT "attachment_reconciliation_scope_check" CHECK ("attachment_reconciliation_cursors"."scope" in ('objects', 'intake'));--> statement-breakpoint
CREATE POLICY "intake_attachment_candidates_organization_isolation" ON "intake_attachment_candidates" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "intake_attachment_upload_claims_organization_isolation" ON "intake_attachment_upload_claims" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "intake_attachments_organization_isolation" ON "intake_attachments" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');
