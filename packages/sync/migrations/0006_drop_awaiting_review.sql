-- Notes no longer have a review state: once the agent marks a note done, it's done.
UPDATE notes SET status = 'Resolved' WHERE status = 'AwaitingReview';
ALTER TABLE notes DROP CONSTRAINT notes_status_check;
ALTER TABLE notes ADD CONSTRAINT notes_status_check CHECK (status IN ('Open', 'AgentWorking', 'Resolved'));
