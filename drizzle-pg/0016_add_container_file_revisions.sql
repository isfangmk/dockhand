CREATE TABLE "container_file_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"environment_id" integer,
	"container_name" text NOT NULL,
	"file_path" text NOT NULL,
	"content" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'editor' NOT NULL,
	"source_label" text,
	"created_by" integer,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "container_file_revisions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "container_file_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "cfr_env_container_path_idx" ON "container_file_revisions" USING btree ("environment_id","container_name","file_path");
--> statement-breakpoint
CREATE INDEX "cfr_env_container_idx" ON "container_file_revisions" USING btree ("environment_id","container_name");
