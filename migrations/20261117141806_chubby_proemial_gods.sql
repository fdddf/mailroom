ALTER TABLE `broadcast` ADD `source` text DEFAULT 'dashboard' NOT NULL;--> statement-breakpoint
ALTER TABLE `broadcast_recipient` ADD `message_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `broadcast_recipient` ADD `delivery` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `broadcast_recipient` ADD `delivery_at` text;--> statement-breakpoint
CREATE INDEX `broadcast_recipient_message` ON `broadcast_recipient` (`message_id`);