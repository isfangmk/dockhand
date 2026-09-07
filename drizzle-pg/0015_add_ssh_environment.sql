ALTER TABLE "environments" ADD COLUMN "ssh_port" integer DEFAULT 22;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "ssh_username" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "ssh_auth_type" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "ssh_password" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "ssh_private_key" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "ssh_passphrase" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "ssh_host_key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "ssh_skip_host_key" boolean DEFAULT false;
