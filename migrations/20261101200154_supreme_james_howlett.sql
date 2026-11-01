CREATE TABLE `pending_subscription` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`form_id` integer NOT NULL,
	`email` text NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`token_hash` text NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`last_sent_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`form_id`) REFERENCES `subscribe_form`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_subscription_token_hash_unique` ON `pending_subscription` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `pending_subscription_email` ON `pending_subscription` (`domain_id`,`email`);--> statement-breakpoint
CREATE INDEX `pending_subscription_form` ON `pending_subscription` (`form_id`);--> statement-breakpoint
CREATE INDEX `pending_subscription_ip` ON `pending_subscription` (`ip`,`last_sent_at`);--> statement-breakpoint
CREATE INDEX `pending_subscription_expires` ON `pending_subscription` (`expires_at`);--> statement-breakpoint
CREATE TABLE `subscribe_form` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`public_id` text NOT NULL,
	`name` text NOT NULL,
	`segment_id` integer,
	`allowed_origins` text NOT NULL,
	`turnstile_site_key` text NOT NULL,
	`turnstile_secret` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`last_error_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`segment_id`) REFERENCES `segment`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscribe_form_public_id_unique` ON `subscribe_form` (`public_id`);--> statement-breakpoint
CREATE INDEX `subscribe_form_domain` ON `subscribe_form` (`domain_id`);--> statement-breakpoint
ALTER TABLE `contact` ADD `confirmed_at` text;