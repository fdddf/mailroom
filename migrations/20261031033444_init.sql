CREATE TABLE `ai_provider` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text DEFAULT '' NOT NULL,
	`model` text NOT NULL,
	`api_key` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `api_key` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`scopes` text NOT NULL,
	`last_used_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_key_hash_unique` ON `api_key` (`hash`);--> statement-breakpoint
CREATE INDEX `api_key_domain` ON `api_key` (`domain_id`);--> statement-breakpoint
CREATE TABLE `broadcast` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`segment_id` integer,
	`from_addr` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`preview_text` text DEFAULT '' NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`format` text DEFAULT 'text' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduled_at` text,
	`sent_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`segment_id`) REFERENCES `segment`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `broadcast_status` ON `broadcast` (`status`);--> statement-breakpoint
CREATE INDEX `broadcast_domain` ON `broadcast` (`domain_id`);--> statement-breakpoint
CREATE TABLE `broadcast_recipient` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broadcast_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`email` text NOT NULL,
	`token` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`claimed_at` text,
	`error` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcast`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `broadcast_recipient_unique` ON `broadcast_recipient` (`broadcast_id`,`contact_id`);--> statement-breakpoint
CREATE INDEX `broadcast_recipient_status` ON `broadcast_recipient` (`broadcast_id`,`status`);--> statement-breakpoint
CREATE TABLE `contact` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`email` text NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`unsubscribed` integer DEFAULT false NOT NULL,
	`token` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_token_unique` ON `contact` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `contact_domain_email` ON `contact` (`domain_id`,`email`);--> statement-breakpoint
CREATE TABLE `contact_segment` (
	`contact_id` integer NOT NULL,
	`segment_id` integer NOT NULL,
	PRIMARY KEY(`contact_id`, `segment_id`),
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`segment_id`) REFERENCES `segment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_segment_segment` ON `contact_segment` (`segment_id`);--> statement-breakpoint
CREATE TABLE `domain` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`brand` text DEFAULT '' NOT NULL,
	`catch_all` integer DEFAULT true NOT NULL,
	`footer` text DEFAULT '' NOT NULL,
	`about` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_name_unique` ON `domain` (`name`);--> statement-breakpoint
CREATE TABLE `mail` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`direction` text NOT NULL,
	`key` text,
	`mailbox` text DEFAULT '' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`from_addr` text DEFAULT '' NOT NULL,
	`to_addrs` text DEFAULT '[]' NOT NULL,
	`cc_addrs` text DEFAULT '[]' NOT NULL,
	`reply_to` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`text` text,
	`html` text,
	`message_id` text DEFAULT '' NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT '' NOT NULL,
	`read_at` text,
	`archived` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mail_direction_check" CHECK("mail"."direction" IN ('in', 'out'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_key_unique` ON `mail` (`key`);--> statement-breakpoint
CREATE INDEX `mail_inbox` ON `mail` (`domain_id`,`direction`,`archived`,"id" DESC);--> statement-breakpoint
CREATE INDEX `mail_mailbox` ON `mail` (`mailbox`,"id" DESC);--> statement-breakpoint
CREATE TABLE `mailbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`address` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`forward_to` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_address_unique` ON `mailbox` (`address`);--> statement-breakpoint
CREATE INDEX `mailbox_domain` ON `mailbox` (`domain_id`);--> statement-breakpoint
CREATE TABLE `segment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `segment_domain_name` ON `segment` (`domain_id`,`name`);--> statement-breakpoint
CREATE TABLE `template` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer,
	`name` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`format` text DEFAULT 'html' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `template_domain` ON `template` (`domain_id`);--> statement-breakpoint
CREATE TABLE `webhook` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`secret` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_at` text,
	`last_status` integer,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_domain` ON `webhook` (`domain_id`);