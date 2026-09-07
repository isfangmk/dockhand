CREATE TABLE `container_file_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`environment_id` integer,
	`container_name` text NOT NULL,
	`file_path` text NOT NULL,
	`content` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'editor' NOT NULL,
	`source_label` text,
	`created_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cfr_env_container_path_idx` ON `container_file_revisions` (`environment_id`,`container_name`,`file_path`);
--> statement-breakpoint
CREATE INDEX `cfr_env_container_idx` ON `container_file_revisions` (`environment_id`,`container_name`);
