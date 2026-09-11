-- Collapse duplicate subscription rows BEFORE the unique index, or this migration cannot apply to
-- any database that already has them. It can: the whole reason for the index is that
-- `ensureSubscription` used to be a check-then-insert with nothing behind it, so two concurrent
-- first requests for one account both inserted.
--
-- Which row survives, in order: one carrying a Stripe subscription id, then one carrying a Stripe
-- customer id, then a paid tier over free, then the oldest, then the lowest rowid. That keeps the
-- row a Stripe webhook can still address and never promotes a free row over a paid one.
DELETE FROM `subscriptions`
WHERE `rowid` NOT IN (
    SELECT `rowid` FROM (
        SELECT
            `rowid`,
            ROW_NUMBER() OVER (
                PARTITION BY `account_id`
                ORDER BY
                    (`stripe_subscription_id` IS NULL),
                    (`stripe_customer_id` IS NULL),
                    (`tier` = 'free'),
                    `created_at`,
                    `rowid`
            ) AS `rn`
        FROM `subscriptions`
    )
    WHERE `rn` = 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_account_id_unique` ON `subscriptions` (`account_id`);
