CREATE TABLE `oauth_client` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`redirect_uris` text NOT NULL,
	`secret_hash` text DEFAULT '' NOT NULL,
	`fetched_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_client_client_id_unique` ON `oauth_client` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_grant` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`domain_id` integer NOT NULL,
	`scopes` text NOT NULL,
	`last_used_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_grant_domain` ON `oauth_grant` (`domain_id`);--> statement-breakpoint
CREATE INDEX `oauth_grant_client` ON `oauth_grant` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_token` (
	`hash` text PRIMARY KEY NOT NULL,
	`grant_id` integer NOT NULL,
	`kind` text NOT NULL,
	`expires_at` text NOT NULL,
	`redirect_uri` text DEFAULT '' NOT NULL,
	`code_challenge` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_token_grant` ON `oauth_token` (`grant_id`);--> statement-breakpoint
CREATE INDEX `oauth_token_expires` ON `oauth_token` (`expires_at`);