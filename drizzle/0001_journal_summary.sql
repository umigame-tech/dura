CREATE TABLE `journal_summaries` (
	`state_id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`covered_through_seq` integer NOT NULL,
	`version` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`state_id`) REFERENCES `states`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `journal_summary_revisions` (
	`state_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`covered_through_seq` integer NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`state_id`, `version`),
	FOREIGN KEY (`state_id`) REFERENCES `states`(`id`) ON UPDATE no action ON DELETE cascade
);
