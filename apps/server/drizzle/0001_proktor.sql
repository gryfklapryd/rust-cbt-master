CREATE TABLE "proctor_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"user_id" uuid,
	"username" text NOT NULL,
	"action" text NOT NULL,
	"schedule_id" uuid,
	"attempt_id" uuid,
	"participant_id" uuid,
	"data" jsonb,
	"at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_proctors" (
	"site_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_proctors_site_id_user_id_pk" PRIMARY KEY("site_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "proctor_actions" ADD CONSTRAINT "proctor_actions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_proctors" ADD CONSTRAINT "site_proctors_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_proctors" ADD CONSTRAINT "site_proctors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proctor_actions_site_at_idx" ON "proctor_actions" USING btree ("site_id","at");--> statement-breakpoint
CREATE INDEX "proctor_actions_attempt_idx" ON "proctor_actions" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "site_proctors_user_idx" ON "site_proctors" USING btree ("user_id");