import logger from "@app/logger";

interface JxaResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * Execute a JXA script via osascript and return the result.
 */
async function runJxa(script: string, timeoutMs = 30_000): Promise<JxaResult> {
    const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => {
            proc.kill();
            reject(new Error(`JXA script timed out after ${timeoutMs}ms`));
        }, timeoutMs)
    );

    const [stdout, stderr, exitCode] = (await Promise.race([
        Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
        timeoutPromise,
    ])) as [string, string, number];

    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/**
 * Escape a string for embedding in a JXA double-quoted string literal.
 */
function escapeJxa(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/**
 * Search message bodies for a query string.
 * Given a list of messages (identified by subject), uses JXA to:
 * 1. Find messages in Mail.app by subject
 * 2. Get body content
 * 3. Check if body contains the query
 *
 * Returns a Set of rowids that matched in the body.
 * Processes in batches of 50 to avoid JXA timeouts.
 */
export async function searchBodies(
    messageIdentifiers: Array<{ rowid: number; subject: string; mailbox: string }>,
    query: string
): Promise<Set<number>> {
    if (messageIdentifiers.length === 0) {
        return new Set();
    }

    const matchedRowids = new Set<number>();
    const batchSize = 50;

    for (let i = 0; i < messageIdentifiers.length; i += batchSize) {
        const batch = messageIdentifiers.slice(i, i + batchSize);
        const subjectList = JSON.stringify(batch.map((m) => ({ rowid: m.rowid, subject: m.subject })));
        const escapedQuery = escapeJxa(query);

        const script = `
            var Mail = Application("Mail");
            var query = "${escapedQuery}".toLowerCase();
            var results = [];
            var identifiers = ${subjectList};

            for (var i = 0; i < identifiers.length; i++) {
                try {
                    var subj = identifiers[i].subject;
                    var found = false;
                    var accounts = Mail.accounts();
                    for (var a = 0; a < accounts.length && !found; a++) {
                        var mailboxes = accounts[a].mailboxes();
                        for (var b = 0; b < mailboxes.length && !found; b++) {
                            try {
                                var msgs = mailboxes[b].messages.whose({
                                    subject: { _equals: subj }
                                })();
                                for (var m = 0; m < msgs.length && !found; m++) {
                                    try {
                                        var content = msgs[m].content();
                                        if (content && content.toLowerCase().indexOf(query) !== -1) {
                                            results.push(identifiers[i].rowid);
                                            found = true;
                                        }
                                    } catch(e) {}
                                }
                            } catch(e) {}
                        }
                    }
                } catch(e) {}
            }
            JSON.stringify(results);
        `;

        try {
            const result = await runJxa(script, 60_000);
            if (result.exitCode === 0 && result.stdout) {
                const rowids = JSON.parse(result.stdout) as number[];
                for (const r of rowids) {
                    matchedRowids.add(r);
                }
            }
        } catch (err) {
            logger.warn(`JXA body search batch failed: ${err}`);
        }
    }

    return matchedRowids;
}

/**
 * Get the full body content of a single message by subject + sender.
 * Returns plain text body or null if not found.
 */
export async function getMessageBody(subject: string, _dateSent: Date, senderAddress: string): Promise<string | null> {
    const escapedSubject = escapeJxa(subject);
    const escapedSender = escapeJxa(senderAddress);

    const script = `
        var Mail = Application("Mail");
        var targetSubject = "${escapedSubject}";
        var targetSender = "${escapedSender}";
        var content = null;

        var accounts = Mail.accounts();
        for (var a = 0; a < accounts.length; a++) {
            if (content !== null) break;
            var mailboxes = accounts[a].mailboxes();
            for (var b = 0; b < mailboxes.length; b++) {
                if (content !== null) break;
                try {
                    var msgs = mailboxes[b].messages.whose({
                        subject: { _equals: targetSubject },
                        sender: { _contains: targetSender }
                    })();
                    if (msgs.length > 0) {
                        try {
                            content = msgs[0].content();
                        } catch(e) {
                            content = "[Could not retrieve body]";
                        }
                    }
                } catch(e) {}
            }
        }
        JSON.stringify({ body: content });
    `;

    try {
        const result = await runJxa(script, 30_000);
        if (result.exitCode === 0 && result.stdout) {
            const parsed = JSON.parse(result.stdout) as { body: string | null };
            return parsed.body;
        }
    } catch (err) {
        logger.warn(`Failed to get message body: ${err}`);
    }
    return null;
}

/**
 * Save an attachment from a message to a local path.
 * Uses JXA to find the message and save the attachment.
 */
export async function saveAttachment(
    subject: string,
    senderAddress: string,
    attachmentName: string,
    savePath: string
): Promise<boolean> {
    const escapedSubject = escapeJxa(subject);
    const escapedSender = escapeJxa(senderAddress);
    const escapedAttName = escapeJxa(attachmentName);
    const escapedPath = escapeJxa(savePath);

    const script = `
        var Mail = Application("Mail");
        var app = Application.currentApplication();
        app.includeStandardAdditions = true;

        var targetSubject = "${escapedSubject}";
        var targetSender = "${escapedSender}";
        var targetAttachment = "${escapedAttName}";
        var savePath = "${escapedPath}";
        var saved = false;

        var accounts = Mail.accounts();
        for (var a = 0; a < accounts.length && !saved; a++) {
            var mailboxes = accounts[a].mailboxes();
            for (var b = 0; b < mailboxes.length && !saved; b++) {
                try {
                    var msgs = mailboxes[b].messages.whose({
                        subject: { _equals: targetSubject },
                        sender: { _contains: targetSender }
                    })();
                    for (var m = 0; m < msgs.length && !saved; m++) {
                        try {
                            var atts = msgs[m].mailAttachments();
                            for (var at = 0; at < atts.length && !saved; at++) {
                                if (atts[at].name() === targetAttachment) {
                                    atts[at].save({ in: Path(savePath) });
                                    saved = true;
                                }
                            }
                        } catch(e) {}
                    }
                } catch(e) {}
            }
        }
        JSON.stringify({ saved: saved });
    `;

    try {
        const result = await runJxa(script, 30_000);
        if (result.exitCode === 0 && result.stdout) {
            const parsed = JSON.parse(result.stdout) as { saved: boolean };
            return parsed.saved;
        }
    } catch (err) {
        logger.warn(`Failed to save attachment: ${err}`);
    }
    return false;
}
