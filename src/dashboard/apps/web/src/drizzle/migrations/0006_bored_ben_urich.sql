-- 0006: add ai_messages.user_id (NOT NULL) + index, backfilled from parent conversation.
-- SQLite cannot ADD a NOT NULL column without default to a non-empty table, so
-- rebuild the table and backfill user_id via a join on ai_conversations.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_ai_messages` (`id`, `user_id`, `conversation_id`, `role`, `content`, `created_at`)
SELECT m.`id`, c.`user_id`, m.`conversation_id`, m.`role`, m.`content`, m.`created_at`
FROM `ai_messages` m
JOIN `ai_conversations` c ON c.`id` = m.`conversation_id`;--> statement-breakpoint
DROP TABLE `ai_messages`;--> statement-breakpoint
ALTER TABLE `__new_ai_messages` RENAME TO `ai_messages`;--> statement-breakpoint
CREATE INDEX `idx_ai_msg_conv_id` ON `ai_messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_msg_user_id` ON `ai_messages` (`user_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
