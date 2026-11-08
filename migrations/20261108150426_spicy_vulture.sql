CREATE TABLE `file` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer,
	`token` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size` integer NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`upload_id` text,
	`downloads` integer DEFAULT 0 NOT NULL,
	`last_download_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_token_unique` ON `file` (`token`);--> statement-breakpoint
CREATE INDEX `file_domain` ON `file` (`domain_id`);--> statement-breakpoint
CREATE INDEX `file_status` ON `file` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `signature` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer,
	`name` text NOT NULL,
	`format` text DEFAULT 'text' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `signature_domain` ON `signature` (`domain_id`);--> statement-breakpoint
ALTER TABLE `mailbox` ADD `signature_id` integer REFERENCES signature(id) ON DELETE SET NULL;