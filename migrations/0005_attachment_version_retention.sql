ALTER TABLE "attachment_candidates" ADD COLUMN "retention" text DEFAULT 'preserve' NOT NULL;--> statement-breakpoint
ALTER TABLE "intake_attachment_candidates" ADD COLUMN "retention" text DEFAULT 'preserve' NOT NULL;--> statement-breakpoint
-- Existing rows retain all history by default. Enforce the invariant on writes without a table scan.
ALTER TABLE "attachment_candidates" ADD CONSTRAINT "attachment_candidates_elected_history_check" CHECK ("attachment_candidates"."retention" in ('preserve', 'candidate', 'transient') and ("attachment_candidates"."status" <> 'elected' or "attachment_candidates"."retention" = 'preserve')) NOT VALID;--> statement-breakpoint
ALTER TABLE "intake_attachment_candidates" ADD CONSTRAINT "intake_attachment_candidates_elected_history_check" CHECK ("intake_attachment_candidates"."retention" in ('preserve', 'candidate', 'transient') and ("intake_attachment_candidates"."status" <> 'elected' or "intake_attachment_candidates"."retention" = 'preserve')) NOT VALID;
