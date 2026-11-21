CREATE TABLE "profile_media_cursors" (
	"scope" text PRIMARY KEY NOT NULL,
	"continuation" text,
	"lease_id" uuid,
	"leased_until" timestamp (3) with time zone,
	CONSTRAINT "profile_media_cursors_scope_check" CHECK ("profile_media_cursors"."scope" in ('cleanup', 'inventory')),
	CONSTRAINT "profile_media_cursors_lease_check" CHECK (("profile_media_cursors"."lease_id" is null) = ("profile_media_cursors"."leased_until" is null))
);
--> statement-breakpoint
ALTER TABLE "profile_media_cursors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_media_cursors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profile_media_objects" (
	"organization_id" uuid,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"cleanup_after" timestamp (3) with time zone NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"lease_id" uuid,
	"leased_until" timestamp (3) with time zone,
	CONSTRAINT "profile_media_objects_owner_kind_owner_id_upload_id_object_id_pk" PRIMARY KEY("owner_kind","owner_id","upload_id","object_id"),
	CONSTRAINT "profile_media_objects_scope_check" CHECK (("profile_media_objects"."owner_kind" = 'avatar' and "profile_media_objects"."organization_id" is null) or ("profile_media_objects"."owner_kind" = 'organization-logo' and "profile_media_objects"."organization_id" is not null and "profile_media_objects"."organization_id" = "profile_media_objects"."owner_id")),
	CONSTRAINT "profile_media_objects_status_check" CHECK ("profile_media_objects"."role" in ('staging','candidate') and "profile_media_objects"."status" in ('active','elected','fenced','cleaned')),
	CONSTRAINT "profile_media_objects_identity_check" CHECK (("profile_media_objects"."role" = 'staging' and "profile_media_objects"."object_id" = "profile_media_objects"."upload_id") or ("profile_media_objects"."role" = 'candidate' and "profile_media_objects"."object_id" <> "profile_media_objects"."upload_id")),
	CONSTRAINT "profile_media_objects_lease_check" CHECK (num_nonnulls("profile_media_objects"."lease_id","profile_media_objects"."leased_until") in (0,2))
);
--> statement-breakpoint
ALTER TABLE "profile_media_objects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_media_objects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profile_media_owners" (
	"organization_id" uuid,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"asset_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"cleanup_requested" boolean DEFAULT false NOT NULL,
	CONSTRAINT "profile_media_owners_owner_kind_owner_id_pk" PRIMARY KEY("owner_kind","owner_id"),
	CONSTRAINT "profile_media_owners_scope_check" CHECK (("profile_media_owners"."owner_kind" = 'avatar' and "profile_media_owners"."organization_id" is null) or ("profile_media_owners"."owner_kind" = 'organization-logo' and "profile_media_owners"."organization_id" is not null and "profile_media_owners"."organization_id" = "profile_media_owners"."owner_id")),
	CONSTRAINT "profile_media_owners_generation_check" CHECK ("profile_media_owners"."generation" between 0 and 9007199254740991 and (not "profile_media_owners"."deleted" or "profile_media_owners"."asset_id" is null))
);
--> statement-breakpoint
ALTER TABLE "profile_media_owners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_media_owners" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profile_media_receipts" (
	"organization_id" uuid,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"lease_id" uuid,
	"leased_until" timestamp (3) with time zone,
	"key_id" text,
	"nonce" "bytea",
	"ciphertext" "bytea",
	"auth_tag" "bytea",
	"receipt_expires_at" timestamp (3) with time zone,
	CONSTRAINT "profile_media_receipts_owner_kind_owner_id_upload_id_pk" PRIMARY KEY("owner_kind","owner_id","upload_id"),
	CONSTRAINT "profile_media_receipts_scope_check" CHECK (("profile_media_receipts"."owner_kind" = 'avatar' and "profile_media_receipts"."organization_id" is null) or ("profile_media_receipts"."owner_kind" = 'organization-logo' and "profile_media_receipts"."organization_id" is not null and "profile_media_receipts"."organization_id" = "profile_media_receipts"."owner_id")),
	CONSTRAINT "profile_media_receipts_lease_check" CHECK (num_nonnulls("profile_media_receipts"."lease_id","profile_media_receipts"."leased_until") in (0,2)),
	CONSTRAINT "profile_media_receipts_sealed_check" CHECK (num_nonnulls("profile_media_receipts"."key_id","profile_media_receipts"."nonce","profile_media_receipts"."ciphertext","profile_media_receipts"."auth_tag","profile_media_receipts"."receipt_expires_at") in (0,5))
);
--> statement-breakpoint
ALTER TABLE "profile_media_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_media_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profile_media_uploads" (
	"organization_id" uuid,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"status" text NOT NULL,
	"uploader_user_id" uuid,
	"content_type" text,
	"size_bytes" integer,
	"expires_at" timestamp (3) with time zone,
	"candidate_id" uuid,
	"width" integer,
	"height" integer,
	"derivative_size_bytes" integer,
	CONSTRAINT "profile_media_uploads_owner_kind_owner_id_upload_id_pk" PRIMARY KEY("owner_kind","owner_id","upload_id"),
	CONSTRAINT "profile_media_uploads_scope_check" CHECK (("profile_media_uploads"."owner_kind" = 'avatar' and "profile_media_uploads"."organization_id" is null) or ("profile_media_uploads"."owner_kind" = 'organization-logo' and "profile_media_uploads"."organization_id" is not null and "profile_media_uploads"."organization_id" = "profile_media_uploads"."owner_id")),
	CONSTRAINT "profile_media_uploads_status_check" CHECK ("profile_media_uploads"."status" in ('pending','prepared','attached','retired')),
	CONSTRAINT "profile_media_uploads_declaration_check" CHECK (num_nonnulls("profile_media_uploads"."uploader_user_id","profile_media_uploads"."content_type","profile_media_uploads"."size_bytes","profile_media_uploads"."expires_at") in (0,4) and ("profile_media_uploads"."status" = 'retired' or "profile_media_uploads"."uploader_user_id" is not null)),
	CONSTRAINT "profile_media_uploads_derivative_check" CHECK (num_nonnulls("profile_media_uploads"."candidate_id","profile_media_uploads"."width","profile_media_uploads"."height","profile_media_uploads"."derivative_size_bytes") in (0,4) and ("profile_media_uploads"."status" not in ('prepared','attached') or "profile_media_uploads"."candidate_id" is not null) and ("profile_media_uploads"."status" <> 'pending' or "profile_media_uploads"."candidate_id" is null))
);
--> statement-breakpoint
ALTER TABLE "profile_media_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_media_uploads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_media_objects" ADD CONSTRAINT "profile_media_objects_upload_fk" FOREIGN KEY ("owner_kind","owner_id","upload_id") REFERENCES "public"."profile_media_uploads"("owner_kind","owner_id","upload_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_media_receipts" ADD CONSTRAINT "profile_media_receipts_upload_fk" FOREIGN KEY ("owner_kind","owner_id","upload_id") REFERENCES "public"."profile_media_uploads"("owner_kind","owner_id","upload_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_media_uploads" ADD CONSTRAINT "profile_media_uploads_owner_fk" FOREIGN KEY ("owner_kind","owner_id") REFERENCES "public"."profile_media_owners"("owner_kind","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_media_objects_physical_key_idx" ON "profile_media_objects" USING btree ("role","object_id");--> statement-breakpoint
CREATE INDEX "profile_media_objects_tenant_idx" ON "profile_media_objects" USING btree ("organization_id","owner_kind","owner_id","upload_id");--> statement-breakpoint
CREATE INDEX "profile_media_objects_due_idx" ON "profile_media_objects" USING btree ("cleanup_after","owner_kind","owner_id","upload_id","object_id") WHERE "profile_media_objects"."status" in ('active','fenced');--> statement-breakpoint
CREATE INDEX "profile_media_owners_tenant_idx" ON "profile_media_owners" USING btree ("organization_id","owner_kind","owner_id");--> statement-breakpoint
CREATE INDEX "profile_media_owners_cleanup_idx" ON "profile_media_owners" USING btree ("owner_kind","owner_id") WHERE "profile_media_owners"."cleanup_requested" = true;--> statement-breakpoint
CREATE INDEX "profile_media_receipts_tenant_idx" ON "profile_media_receipts" USING btree ("organization_id","owner_kind","owner_id","upload_id");--> statement-breakpoint
CREATE INDEX "profile_media_receipts_expiry_idx" ON "profile_media_receipts" USING btree ("receipt_expires_at","owner_kind","owner_id","upload_id") WHERE "profile_media_receipts"."receipt_expires_at" is not null;--> statement-breakpoint
CREATE INDEX "profile_media_uploads_tenant_idx" ON "profile_media_uploads" USING btree ("organization_id","owner_kind","owner_id","upload_id");--> statement-breakpoint
CREATE INDEX "profile_media_uploads_pending_expiry_idx" ON "profile_media_uploads" USING btree ("expires_at","owner_kind","owner_id","upload_id") WHERE "profile_media_uploads"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "profile_media_uploads_compaction_idx" ON "profile_media_uploads" USING btree ("owner_kind","owner_id","upload_id") WHERE "profile_media_uploads"."uploader_user_id" is not null or "profile_media_uploads"."candidate_id" is not null;--> statement-breakpoint
CREATE POLICY "profile_media_cursors_system_access" ON "profile_media_cursors" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.system_access', true) = 'on') WITH CHECK (current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "profile_media_objects_organization_isolation" ON "profile_media_objects" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "profile_media_owners_organization_isolation" ON "profile_media_owners" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "profile_media_receipts_organization_isolation" ON "profile_media_receipts" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "profile_media_uploads_organization_isolation" ON "profile_media_uploads" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');
