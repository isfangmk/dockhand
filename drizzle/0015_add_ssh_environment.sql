ALTER TABLE `environments` ADD `ssh_port` integer DEFAULT 22;--> statement-breakpoint
ALTER TABLE `environments` ADD `ssh_username` text;--> statement-breakpoint
ALTER TABLE `environments` ADD `ssh_auth_type` text;--> statement-breakpoint
ALTER TABLE `environments` ADD `ssh_password` text;--> statement-breakpoint
ALTER TABLE `environments` ADD `ssh_private_key` text;--> statement-breakpoint
ALTER TABLE `environments` ADD `ssh_passphrase` text;--> statement-breakpoint
ALTER TABLE `environments` ADD `ssh_host_key_fingerprint` text;--> statement-breakpoint
ALTER TABLE `environments` ADD `ssh_skip_host_key` integer DEFAULT false;
